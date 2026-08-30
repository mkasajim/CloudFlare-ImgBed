/* 索引管理器 */

/**
 * 文件索引结构（分块存储）：
 * 
 * 索引元数据：
 * - key: manage@index@meta
 * - value: JSON.stringify(metadata)
 * - metadata: {
 *     lastUpdated: 1640995200000,
 *     totalCount: 1000,
 *     lastOperationId: "operation_timestamp_uuid",
 *     chunkCount: 3,
 *     chunkSize: 10000
 *   }
 * 
 * 索引分块：
 * - key: manage@index_${chunkId} (例如: manage@index_0, manage@index_1, ...)
 * - value: JSON.stringify(filesChunk)
 * - filesChunk: [
 *     {
 *       id: "file_unique_id",
 *       metadata: {}
 *     },
 *     ...
 *   ]
 * 
 * 原子操作结构（保持不变）：
 * - key: manage@index@operation_${timestamp}_${uuid}
 * - value: JSON.stringify(operation)
 * - operation: {
 *     type: "add" | "remove" | "move" | "batch_add" | "batch_remove" | "batch_move",
 *     timestamp: 1640995200000,
 *     data: {
 *       // 根据操作类型包含不同的数据
 *     }
 *   }
 */

import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';

const INDEX_KEY = 'manage@index';
const INDEX_META_KEY = 'manage@index@meta'; // 索引元数据键
const OPERATION_KEY_PREFIX = 'manage@index@operation_';
// D1 单字段限制 2MB，KV 限制 25MB，根据数据库类型动态设置
const INDEX_CHUNK_SIZE_D1 = 500; // D1 数据库分块大小
const INDEX_CHUNK_SIZE_KV = 5000; // KV 存储分块大小
const KV_LIST_LIMIT = 1000; // 数据库列出批量大小
const BATCH_SIZE = 10; // 批量处理大小

/**
 * 根据数据库类型获取索引分块大小
 * @param {Object} env - 环境变量
 * @returns {number} 分块大小
 */
export function getIndexChunkSize(env) {
    const config = checkDatabaseConfig(env);
    return config.usingD1 ? INDEX_CHUNK_SIZE_D1 : INDEX_CHUNK_SIZE_KV;
}

/* ============= D1 SQL 直查模式 ============= */
/**
 * 当后端为 D1 数据库时，文件列表/统计不再依赖 JSON 分块索引，
 * 而是直接通过 SQL 查询 files 表（表内已有 timestamp/directory/channel 等索引列）。
 * 这样可以避免在请求内解析数十 MB 的索引 JSON，突破 CPU 时间限制。
 */

// 基础过滤条件：跳过无时间戳的记录和分片临时记录（与原索引构建时的跳过规则一致）
const D1_BASE_FILE_FILTER = "timestamp IS NOT NULL AND substr(id, 1, 6) <> 'chunk_'";

function isD1Backend(context) {
    return checkDatabaseConfig(context.env).usingD1;
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (m) => '\\' + m);
}

function parseMetadata(metadataStr) {
    if (!metadataStr) return {};
    try {
        const parsed = JSON.parse(metadataStr);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function d1All(context, sql, params = []) {
    const adapter = getDatabase(context.env);
    let stmt = adapter.db.prepare(sql);
    if (params.length > 0) {
        stmt = stmt.bind(...params);
    }
    const response = await stmt.all();
    return response.results || [];
}

async function d1First(context, sql, params = []) {
    const adapter = getDatabase(context.env);
    let stmt = adapter.db.prepare(sql);
    if (params.length > 0) {
        stmt = stmt.bind(...params);
    }
    return await stmt.first();
}

async function d1Run(context, sql, params = []) {
    const adapter = getDatabase(context.env);
    let stmt = adapter.db.prepare(sql);
    if (params.length > 0) {
        stmt = stmt.bind(...params);
    }
    await stmt.run();
}

/**
 * 构建与原索引 readIndex 过滤语义一致的 SQL 条件
 * @param {Object} options - 已归一化为数组的过滤选项
 * @returns {{where: string, params: Array}} SQL WHERE 片段与绑定参数
 */
function buildD1FileFilter(options = {}) {
    const {
        search = '',
        channel = [],
        listType = [],
        accessStatus = [],
        label = [],
        fileType = [],
        channelName = [],
        includeTags = [],
        excludeTags = [],
    } = options;

    const params = [];
    const conditions = [D1_BASE_FILE_FILTER];

    // 关键字搜索（文件名或文件ID，大小写不敏感）
    if (search) {
        const pattern = `%${escapeLike(search)}%`;
        conditions.push("(file_name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
    }

    // 渠道过滤（多选 OR，大小写不敏感）
    if (channel.length > 0) {
        conditions.push(`LOWER(COALESCE(channel, '')) IN (${channel.map(() => '?').join(',')})`);
        params.push(...channel.map((c) => String(c).toLowerCase()));
    }

    // 列表类型过滤（White/Block/None）
    if (listType.length > 0) {
        const parts = listType.map((lt) => {
            if (lt === 'None') {
                return "(list_type IS NULL OR list_type = '' OR list_type = 'None')";
            }
            params.push(lt);
            return 'list_type = ?';
        });
        conditions.push(`(${parts.join(' OR ')})`);
    }

    // 访问状态过滤（normal=非屏蔽, blocked=已屏蔽；白名单优先）
    if (accessStatus.length > 0) {
        const blockedCond = "COALESCE(list_type = 'Block' OR (label = 'adult' AND (list_type IS NULL OR list_type <> 'White')), 0)";
        const parts = accessStatus.map((status) => {
            if (status === 'normal') {
                return `NOT ${blockedCond}`;
            }
            if (status === 'blocked') {
                return blockedCond;
            }
            return '1 = 0';
        });
        conditions.push(`(${parts.join(' OR ')})`);
    }

    // 审查结果过滤（normal/teen/adult）
    if (label.length > 0) {
        const parts = label.map((lbl) => {
            if (lbl === 'normal') {
                return "(label IS NULL OR label = '' OR label = 'None' OR label = 'everyone')";
            }
            if (lbl === 'teen') {
                return "label = 'teen'";
            }
            if (lbl === 'adult') {
                return "label = 'adult'";
            }
            return '1 = 0';
        });
        conditions.push(`(${parts.join(' OR ')})`);
    }

    // 文件类型过滤（image/video/audio/other）
    if (fileType.length > 0) {
        const parts = fileType.map((ft) => {
            if (ft === 'image') return "file_type LIKE 'image/%'";
            if (ft === 'video') return "file_type LIKE 'video/%'";
            if (ft === 'audio') return "file_type LIKE 'audio/%'";
            if (ft === 'other') {
                return "(file_type IS NULL OR (file_type NOT LIKE 'image/%' AND file_type NOT LIKE 'video/%' AND file_type NOT LIKE 'audio/%'))";
            }
            return '1 = 0';
        });
        conditions.push(`(${parts.join(' OR ')})`);
    }

    // 渠道名称过滤（支持 "type:name" 格式或单独名称）
    if (channelName.length > 0) {
        const parts = channelName.map((filterValue) => {
            if (filterValue.includes(':')) {
                const segments = filterValue.split(':');
                params.push(segments[0], segments[1]);
                return '(channel = ? AND channel_name = ?)';
            }
            params.push(filterValue);
            return 'channel_name = ?';
        });
        conditions.push(`(${parts.join(' OR ')})`);
    }

    // 标签过滤（tags 列为 JSON 数组字符串，按精确标签匹配）
    for (const tag of includeTags) {
        if (!tag) continue;
        conditions.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapeLike(String(tag).toLowerCase())}"%`);
    }
    for (const tag of excludeTags) {
        if (!tag) continue;
        conditions.push("(tags IS NULL OR tags NOT LIKE ? ESCAPE '\\')");
        params.push(`%"${escapeLike(String(tag).toLowerCase())}"%`);
    }

    return { where: conditions.join(' AND '), params };
}

/**
 * 构建目录范围条件
 * @param {string} dirPrefix - 目录前缀（以 / 结尾，根目录为空字符串）
 * @param {'recursive'|'direct'} mode - recursive 含子目录，direct 仅当前目录
 */
function buildD1DirectoryCond(dirPrefix, mode) {
    if (dirPrefix === '') {
        if (mode === 'direct') {
            return { cond: "(directory IS NULL OR directory = '')", params: [] };
        }
        return { cond: '', params: [] };
    }
    if (mode === 'direct') {
        return { cond: 'directory = ?', params: [dirPrefix] };
    }
    return { cond: "directory LIKE ? ESCAPE '\\'", params: [escapeLike(dirPrefix) + '%'] };
}

/**
 * 查询当前目录的直接子目录（基于过滤后的记录）
 */
async function queryImmediateSubdirectoriesD1(context, filter, dirPrefix) {
    let sql;
    const params = [...filter.params];
    if (dirPrefix === '') {
        sql = `SELECT DISTINCT substr(directory, 1, instr(directory, '/')) AS d FROM files WHERE ${filter.where} AND directory IS NOT NULL AND directory <> ''`;
    } else {
        const prefixLength = dirPrefix.length;
        sql = `SELECT DISTINCT substr(directory, 1, ${prefixLength} + instr(substr(directory, ${prefixLength + 1}), '/')) AS d FROM files WHERE ${filter.where} AND directory LIKE ? ESCAPE '\\'`;
        params.push(escapeLike(dirPrefix) + '\\_%');
    }
    const rows = await d1All(context, sql, params);
    return rows.map((row) => row.d).filter(Boolean);
}

/**
 * D1 后端的 readIndex 实现：SQL 分页查询，返回结构与索引模式一致
 */
async function readIndexD1(context, options = {}) {
    const {
        search = '',
        directory = '',
        start = 0,
        count = 50,
        channel = [],
        listType = [],
        accessStatus = [],
        label = [],
        fileType = [],
        channelName = [],
        includeTags = [],
        excludeTags = [],
        countOnly = false,
        includeSubdirFiles = false,
        lite = false,
    } = options;

    const channelArr = Array.isArray(channel) ? channel : (channel ? [channel] : []);
    const listTypeArr = Array.isArray(listType) ? listType : (listType ? [listType] : []);
    const accessStatusArr = Array.isArray(accessStatus) ? accessStatus : (accessStatus ? [accessStatus] : []);
    const labelArr = Array.isArray(label) ? label : (label ? [label] : []);
    const fileTypeArr = Array.isArray(fileType) ? fileType : (fileType ? [fileType] : []);
    const channelNameArr = Array.isArray(channelName) ? channelName : (channelName ? [channelName] : []);

    const dirPrefix = directory === '' || directory.endsWith('/') ? directory : directory + '/';

    try {
        const filter = buildD1FileFilter({
            search,
            channel: channelArr,
            listType: listTypeArr,
            accessStatus: accessStatusArr,
            label: labelArr,
            fileType: fileTypeArr,
            channelName: channelNameArr,
            includeTags,
            excludeTags,
        });

        const recursiveDir = buildD1DirectoryCond(dirPrefix, 'recursive');
        const directDir = buildD1DirectoryCond(dirPrefix, 'direct');

        // 递归范围内的总数（与原索引实现的 totalCount 语义一致）
        const countSql = `SELECT COUNT(*) AS c FROM files WHERE ${filter.where}${recursiveDir.cond ? ' AND ' + recursiveDir.cond : ''}`;
        const countRow = await d1First(context, countSql, [...filter.params, ...recursiveDir.params]);
        const totalCount = countRow?.c || 0;

        if (countOnly) {
            return {
                totalCount,
                indexLastUpdated: Date.now(),
            };
        }

        // 当前目录直接文件数
        const directCountSql = `SELECT COUNT(*) AS c FROM files WHERE ${filter.where} AND ${directDir.cond}`;
        const directCountRow = await d1First(context, directCountSql, [...filter.params, ...directDir.params]);
        const directFileCount = directCountRow?.c || 0;

        // 分页数据（lite 模式仅查询必要字段，用于公开列表等全量场景）
        const pageDir = includeSubdirFiles ? recursiveDir : directDir;
        const selectColumns = lite
            ? "id, json_extract(metadata, '$.FileType') AS FileType, json_extract(metadata, '$.TimeStamp') AS TimeStamp, json_extract(metadata, '$.FileSize') AS FileSize"
            : 'id, metadata';
        let pageSql = `SELECT ${selectColumns} FROM files WHERE ${filter.where}${pageDir.cond ? ' AND ' + pageDir.cond : ''} ORDER BY timestamp DESC, id DESC`;
        const pageParams = [...filter.params, ...pageDir.params];
        if (count !== -1) {
            pageSql += ' LIMIT ? OFFSET ?';
            pageParams.push(Math.max(1, count), Math.max(0, start));
        } else if (lite) {
            // 轻量全量列表设置安全上限，避免超出 D1 响应大小限制
            pageSql += ' LIMIT 20000';
        }
        const rows = await d1All(context, pageSql, pageParams);

        const files = lite
            ? rows.map((row) => ({
                id: row.id,
                metadata: {
                    FileType: row.FileType ?? undefined,
                    TimeStamp: row.TimeStamp ?? undefined,
                    FileSize: row.FileSize ?? undefined,
                },
            }))
            : rows.map((row) => ({ id: row.id, metadata: parseMetadata(row.metadata) }));

        // 当前目录的直接子目录
        const directories = await queryImmediateSubdirectoriesD1(context, filter, dirPrefix);

        return {
            files,
            directories,
            totalCount,
            directFileCount,
            directFolderCount: directories.length,
            indexLastUpdated: Date.now(),
            returnedCount: files.length,
            success: true,
        };
    } catch (error) {
        console.error('Error reading index (D1 SQL):', error);
        return {
            files: [],
            directories: [],
            totalCount: 0,
            indexLastUpdated: Date.now(),
            returnedCount: 0,
            success: false,
        };
    }
}

/**
 * D1 后端的容量统计（实时 SQL 聚合，带短 TTL 缓存以降低读取量）
 */
let d1IndexMetaCache = { data: null, expiresAt: 0 };

async function getIndexMetaD1(context) {
    try {
        const now = Date.now();
        if (d1IndexMetaCache.data && now < d1IndexMetaCache.expiresAt) {
            return d1IndexMetaCache.data;
        }

        const [totalRow, channelRows] = await Promise.all([
            d1First(context, `SELECT COUNT(*) AS fileCount, SUM(CAST(file_size AS REAL)) AS usedMB FROM files WHERE ${D1_BASE_FILE_FILTER}`),
            d1All(context, `SELECT channel_name, COUNT(*) AS fileCount, SUM(CAST(file_size AS REAL)) AS usedMB FROM files WHERE ${D1_BASE_FILE_FILTER} AND channel_name IS NOT NULL AND channel_name <> '' GROUP BY channel_name`),
        ]);

        const channelStats = {};
        for (const row of channelRows) {
            channelStats[row.channel_name] = {
                usedMB: row.usedMB || 0,
                fileCount: row.fileCount || 0,
            };
        }

        const result = {
            success: true,
            totalCount: totalRow?.fileCount || 0,
            totalSizeMB: Math.round((totalRow?.usedMB || 0) * 100) / 100,
            channelStats,
            lastUpdated: now,
        };

        d1IndexMetaCache = { data: result, expiresAt: now + 30 * 1000 };
        return result;
    } catch (error) {
        console.error('Error getting index meta (D1 SQL):', error);
        return {
            success: false,
            totalCount: 0,
            totalSizeMB: 0,
            channelStats: {},
        };
    }
}

/**
 * D1 后端的上传趋势：按天/渠道聚合后在前端桶内汇总
 */
function buildTrendFromD1Rows(rows, options) {
    const { timezoneOffset, maxPoints, seriesLimit } = options;

    let newestDay = null;
    let oldestDay = null;
    for (const row of rows) {
        const day = Number(row.day);
        if (!Number.isFinite(day)) continue;
        if (newestDay === null || day > newestDay) newestDay = day;
        if (oldestDay === null || day < oldestDay) oldestDay = day;
    }

    const optionStartDay = parseTrendDate(options.startDate);
    const optionEndDay = parseTrendDate(options.endDate);
    let range = null;
    if (optionStartDay !== null || optionEndDay !== null) {
        const startDay = optionStartDay !== null ? optionStartDay : (oldestDay !== null ? oldestDay : optionEndDay);
        const endDay = optionEndDay !== null ? optionEndDay : (newestDay !== null ? newestDay : optionStartDay);
        range = startDay <= endDay ? { startDay, endDay } : { startDay: endDay, endDay: startDay };
    } else if (newestDay !== null && oldestDay !== null) {
        range = oldestDay > newestDay
            ? { startDay: newestDay, endDay: oldestDay }
            : { startDay: oldestDay, endDay: newestDay };
    }

    if (!range) {
        return finalizeUploadTrend({ enabled: false, timezoneOffset, maxPoints, seriesLimit });
    }

    const spanDays = range.endDay - range.startDay + 1;
    const bucketSizeDays = Math.max(1, Math.ceil(spanDays / maxPoints));
    const bucketCount = Math.ceil(spanDays / bucketSizeDays);

    const accumulator = {
        enabled: true,
        timezoneOffset,
        maxPoints,
        seriesLimit,
        startDay: range.startDay,
        endDay: range.endDay,
        bucketSizeDays,
        bucketCount,
        labels: buildTrendBucketLabels(range.startDay, range.endDay, bucketSizeDays, bucketCount),
        total: Array(bucketCount).fill(0),
        channelGroups: new Map(),
        channelNameGroups: new Map(),
    };

    for (const row of rows) {
        const day = Number(row.day);
        if (!Number.isFinite(day)) continue;
        const bucketIndex = Math.floor((day - range.startDay) / bucketSizeDays);
        if (bucketIndex < 0 || bucketIndex >= bucketCount) continue;
        const count = Number(row.c) || 0;
        accumulator.total[bucketIndex] += count;
        addTrendGroupPoint(accumulator.channelGroups, row.ch, bucketIndex, count);
        addTrendGroupPoint(accumulator.channelNameGroups, row.cname, bucketIndex, count);
    }

    return finalizeUploadTrend(accumulator);
}

/**
 * D1 后端的索引信息（SQL 聚合统计，带短 TTL 缓存）
 */
let d1IndexInfoCache = { data: null, expiresAt: 0 };

async function getIndexInfoD1(context, options = {}) {
    try {
        const now = Date.now();
        if (d1IndexInfoCache.data && now < d1IndexInfoCache.expiresAt) {
            return d1IndexInfoCache.data;
        }

        const channelCase = "CASE WHEN channel = 'TelegramNew' THEN 'Telegram' WHEN channel IS NULL OR channel = '' THEN 'Telegraph' ELSE channel END";

        const [channelRows, directoryRows, typeRows, totalRow, newestRow, oldestRow, trendRows] = await Promise.all([
            d1All(context, `SELECT ${channelCase} AS ch, COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER} GROUP BY ch`),
            d1All(context, `SELECT CASE WHEN directory IS NOT NULL AND directory <> '' THEN directory ELSE '/' END AS d, COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER} GROUP BY d`),
            d1All(context, `SELECT CASE WHEN label = 'adult' AND (list_type IS NULL OR list_type <> 'White') THEN 'Block' WHEN list_type IS NULL OR list_type = '' OR list_type = 'None' THEN 'None' ELSE list_type END AS t, COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER} GROUP BY t`),
            d1First(context, `SELECT COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER}`),
            d1First(context, `SELECT id, metadata FROM files WHERE ${D1_BASE_FILE_FILTER} ORDER BY timestamp DESC, id DESC LIMIT 1`),
            d1First(context, `SELECT id, metadata FROM files WHERE ${D1_BASE_FILE_FILTER} ORDER BY timestamp ASC, id DESC LIMIT 1`),
            d1All(context, `SELECT CAST((timestamp - ?) / 86400000 AS INTEGER) AS day, ${channelCase} AS ch, COALESCE(NULLIF(channel_name, ''), ${channelCase}) AS cname, COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER} GROUP BY day, ch, cname`, [normalizeInteger(options.timezoneOffset, 0, -14 * 60, 14 * 60) * 60 * 1000]),
        ]);

        const channelStats = {};
        for (const row of channelRows) {
            const key = normalizeTrendKey(row.ch);
            channelStats[key] = (channelStats[key] || 0) + row.c;
        }

        const directoryStats = {};
        for (const row of directoryRows) {
            const key = normalizeTrendKey(row.d);
            directoryStats[key] = (directoryStats[key] || 0) + row.c;
        }

        const typeStats = {};
        for (const row of typeRows) {
            const key = normalizeTrendKey(row.t);
            typeStats[key] = (typeStats[key] || 0) + row.c;
        }

        const uploadTrend = buildTrendFromD1Rows(trendRows, {
            timezoneOffset: normalizeInteger(options.timezoneOffset, 0, -14 * 60, 14 * 60),
            maxPoints: normalizeInteger(options.maxPoints, DEFAULT_TREND_MAX_POINTS, 7, MAX_TREND_POINTS),
            seriesLimit: normalizeInteger(options.seriesLimit, DEFAULT_TREND_SERIES_LIMIT, 1, MAX_TREND_SERIES_LIMIT),
            startDate: options.startDate,
            endDate: options.endDate,
        });

        const result = {
            success: true,
            totalFiles: totalRow?.c || 0,
            lastUpdated: now,
            channelStats,
            directoryStats,
            typeStats,
            uploadTrend,
            oldestFile: oldestRow ? { id: oldestRow.id, metadata: parseMetadata(oldestRow.metadata) } : undefined,
            newestFile: newestRow ? { id: newestRow.id, metadata: parseMetadata(newestRow.metadata) } : undefined,
        };

        d1IndexInfoCache = { data: result, expiresAt: now + 60 * 1000 };
        return result;
    } catch (error) {
        console.error('Error getting index info (D1 SQL):', error);
        return null;
    }
}

/**
 * D1 后端的目录树（SQL DISTINCT 查询）
 */
async function getDirectoryTreeD1(context) {
    const rows = await d1All(context, `SELECT DISTINCT directory FROM files WHERE directory IS NOT NULL AND directory <> '' AND timestamp IS NOT NULL AND substr(id, 1, 6) <> 'chunk_'`);
    const directories = rows.map((row) => row.directory);
    return buildTree(directories);
}

/**
 * D1 后端的"重建索引"：无需重建，仅清理遗留的 JSON 索引与操作记录
 */
async function rebuildIndexD1(context) {
    try {
        const countRow = await d1First(context, `SELECT COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER}`);
        const total = countRow?.c || 0;

        await d1Run(context, "DELETE FROM settings WHERE key = 'manage@index@meta' OR key LIKE 'manage@index\\_%' ESCAPE '\\'");
        await d1Run(context, 'DELETE FROM index_operations');

        console.log(`D1 SQL mode: no index rebuild needed, ${total} files queryable directly.`);
        return {
            success: true,
            processedCount: total,
            indexedCount: total,
        };
    } catch (error) {
        console.error('Error in D1 index cleanup:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * 添加文件到索引
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @param {string} fileId - 文件 ID
 * @param {Object} metadata - 文件元数据
 */
export async function addFileToIndex(context, fileId, metadata = null) {
    // D1 后端：files 表即实时索引，无需记录原子操作
    if (isD1Backend(context)) {
        return { success: true, operationId: null };
    }
    const { env } = context;
    const db = getDatabase(env);

    try {
        if (metadata === null) {
            // 如果未传入metadata，尝试从数据库中获取
            const fileData = await db.getWithMetadata(fileId);
            metadata = fileData.metadata || {};
        }

        // 记录原子操作
        const operationId = await recordOperation(context, 'add', {
            fileId,
            metadata
        });

        console.log(`File ${fileId} add operation recorded with ID: ${operationId}`);
        return { success: true, operationId };
    } catch (error) {
        console.error('Error recording add file operation:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 批量添加文件到索引
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @param {Array} files - 文件数组，每个元素包含 { fileId, metadata }
 * @param {Object} options - 选项
 * @param {boolean} options.skipExisting - 是否跳过已存在的文件，默认为 false（更新已存在的文件）
 * @returns {Object} 返回操作结果 { operationId, totalProcessed }
 */
export async function batchAddFilesToIndex(context, files, options = {}) {
    try {
        // D1 后端：files 表即实时索引，无需记录原子操作
        if (isD1Backend(context)) {
            return {
                success: true,
                operationId: null,
                totalProcessed: files.length
            };
        }
        const { env } = context;
        const { skipExisting = false } = options;
        const db = getDatabase(env);

        // 处理每个文件的metadata
        const processedFiles = [];
        for (const fileItem of files) {
            const { fileId, metadata } = fileItem;
            let finalMetadata = metadata;

            // 如果没有提供metadata，尝试从数据库中获取
            if (!finalMetadata) {
                try {
                    const fileData = await db.getWithMetadata(fileId);
                    finalMetadata = fileData.metadata || {};
                } catch (error) {
                    console.warn(`Failed to get metadata for file ${fileId}:`, error);
                    finalMetadata = {};
                }
            }

            processedFiles.push({
                fileId,
                metadata: finalMetadata
            });
        }

        // 记录批量添加操作
        const operationId = await recordOperation(context, 'batch_add', {
            files: processedFiles,
            options: { skipExisting }
        });

        console.log(`Batch add operation recorded with ID: ${operationId}, ${files.length} files`);
        return {
            success: true,
            operationId,
            totalProcessed: files.length
        };
    } catch (error) {
        console.error('Error recording batch add files operation:', error);
        return {
            success: false,
            error: error.message,
            totalProcessed: 0
        };
    }
}

/**
 * 从索引中删除文件
 * @param {Object} context - 上下文对象
 * @param {string} fileId - 文件 ID
 */
export async function removeFileFromIndex(context, fileId) {
    try {
        // D1 后端：files 表即实时索引，无需记录原子操作
        if (isD1Backend(context)) {
            return { success: true, operationId: null };
        }
        // 记录删除操作
        const operationId = await recordOperation(context, 'remove', {
            fileId
        });

        console.log(`File ${fileId} remove operation recorded with ID: ${operationId}`);
        return { success: true, operationId };
    } catch (error) {
        console.error('Error recording remove file operation:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 批量删除文件
 * @param {Object} context - 上下文对象
 * @param {Array} fileIds - 文件 ID 数组
 */
export async function batchRemoveFilesFromIndex(context, fileIds) {
    try {
        // D1 后端：files 表即实时索引，无需记录原子操作
        if (isD1Backend(context)) {
            return {
                success: true,
                operationId: null,
                totalProcessed: fileIds.length
            };
        }
        // 记录批量删除操作
        const operationId = await recordOperation(context, 'batch_remove', {
            fileIds
        });

        console.log(`Batch remove operation recorded with ID: ${operationId}, ${fileIds.length} files`);
        return {
            success: true,
            operationId,
            totalProcessed: fileIds.length
        };
    } catch (error) {
        console.error('Error recording batch remove files operation:', error);
        return {
            success: false,
            error: error.message,
            totalProcessed: 0
        };
    }
}

/**
 * 移动文件（修改文件ID）
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @param {string} originalFileId - 原文件 ID
 * @param {string} newFileId - 新文件 ID
 * @param {Object} newMetadata - 新的元数据，如果为null则获取原文件的metadata
 * @returns {Object} 返回操作结果 { success, operationId?, error? }
 */
export async function moveFileInIndex(context, originalFileId, newFileId, newMetadata = null) {
    try {
        // D1 后端：files 表即实时索引，无需记录原子操作
        if (isD1Backend(context)) {
            return { success: true, operationId: null };
        }
        const { env } = context;
        const db = getDatabase(env);

        // 确定最终的metadata
        let finalMetadata = newMetadata;
        if (finalMetadata === null) {
            // 如果没有提供新metadata，尝试从数据库中获取
            try {
                const fileData = await db.getWithMetadata(newFileId);
                finalMetadata = fileData.metadata || {};
            } catch (error) {
                console.warn(`Failed to get metadata for new file ${newFileId}:`, error);
                finalMetadata = {};
            }
        }

        // 记录移动操作
        const operationId = await recordOperation(context, 'move', {
            originalFileId,
            newFileId,
            metadata: finalMetadata
        });

        console.log(`File move operation from ${originalFileId} to ${newFileId} recorded with ID: ${operationId}`);
        return { success: true, operationId };
    } catch (error) {
        console.error('Error recording move file operation:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 批量移动文件
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @param {Array} moveOperations - 移动操作数组，每个元素包含 { originalFileId, newFileId, metadata? }
 * @returns {Object} 返回操作结果 { operationId, totalProcessed }
 */
export async function batchMoveFilesInIndex(context, moveOperations) {
    try {
        // D1 后端：files 表即实时索引，无需记录原子操作
        if (isD1Backend(context)) {
            return {
                success: true,
                operationId: null,
                totalProcessed: moveOperations.length
            };
        }
        const { env } = context;
        const db = getDatabase(env);

        // 处理每个移动操作的metadata
        const processedOperations = [];
        for (const operation of moveOperations) {
            const { originalFileId, newFileId, metadata } = operation;

            // 确定最终的metadata
            let finalMetadata = metadata;
            if (finalMetadata === null || finalMetadata === undefined) {
                // 如果没有提供新metadata，尝试从数据库中获取
                try {
                    const fileData = await db.getWithMetadata(newFileId);
                    finalMetadata = fileData.metadata || {};
                } catch (error) {
                    console.warn(`Failed to get metadata for new file ${newFileId}:`, error);
                    finalMetadata = {};
                }
            }

            processedOperations.push({
                originalFileId,
                newFileId,
                metadata: finalMetadata
            });
        }

        // 记录批量移动操作
        const operationId = await recordOperation(context, 'batch_move', {
            operations: processedOperations
        });

        console.log(`Batch move operation recorded with ID: ${operationId}, ${moveOperations.length} operations`);
        return {
            success: true,
            operationId,
            totalProcessed: moveOperations.length
        };
    } catch (error) {
        console.error('Error recording batch move files operation:', error);
        return {
            success: false,
            error: error.message,
            totalProcessed: 0
        };
    }
}

/**
 * 合并所有挂起的操作到索引中
 * @param {Object} context - 上下文对象
 * @param {Object} options - 选项
 * @param {boolean} options.cleanupAfterMerge - 合并后是否清理操作记录，默认为 true
 * @returns {Object} 合并结果
 */
export async function mergeOperationsToIndex(context, options = {}) {
    // D1 后端：无 JSON 索引，无需合并操作
    if (isD1Backend(context)) {
        return {
            success: true,
            processedOperations: 0,
            message: 'No pending operations'
        };
    }
    const { request } = context;
    const { cleanupAfterMerge = true } = options;
    
    try {
        console.log('Starting operations merge...');
        
        // 获取当前索引
        const currentIndex = await getIndex(context);
        if (currentIndex.success === false) {
            console.error('Failed to get current index for merge');
            return {
                success: false,
                error: 'Failed to get current index'
            };
        }

        // 获取所有待处理的操作
        const operationsResult = await getAllPendingOperations(context, currentIndex.lastOperationId);

        const operations = operationsResult.operations;
        const isALLOperations = operationsResult.isAll;

        if (operations.length === 0) {
            console.log('No pending operations to merge');
            return {
                success: true,
                processedOperations: 0,
                message: 'No pending operations'
            };
        }

        console.log(`Found ${operations.length} pending operations to merge. Is all operations: ${isALLOperations}, if there are remaining operations they will be processed in the next merge.`);

        // 按时间戳排序操作，确保按正确顺序应用
        operations.sort((a, b) => a.timestamp - b.timestamp);

        // 创建索引的副本进行操作
        const workingIndex = currentIndex;
        let operationsProcessed = 0;
        let addedCount = 0;
        let removedCount = 0;
        let movedCount = 0;
        let updatedCount = 0;
        const processedOperationIds = [];

        // 应用每个操作
        for (const operation of operations) {
            try {
                switch (operation.type) {
                    case 'add':
                        const addResult = applyAddOperation(workingIndex, operation.data);
                        if (addResult.added) addedCount++;
                        if (addResult.updated) updatedCount++;
                        break;
                        
                    case 'remove':
                        if (applyRemoveOperation(workingIndex, operation.data)) {
                            removedCount++;
                        }
                        break;
                        
                    case 'move':
                        if (applyMoveOperation(workingIndex, operation.data)) {
                            movedCount++;
                        }
                        break;
                        
                    case 'batch_add':
                        const batchAddResult = applyBatchAddOperation(workingIndex, operation.data);
                        addedCount += batchAddResult.addedCount;
                        updatedCount += batchAddResult.updatedCount;
                        break;
                        
                    case 'batch_remove':
                        removedCount += applyBatchRemoveOperation(workingIndex, operation.data);
                        break;
                        
                    case 'batch_move':
                        movedCount += applyBatchMoveOperation(workingIndex, operation.data);
                        break;
                        
                    default:
                        console.warn(`Unknown operation type: ${operation.type}`);
                        continue;
                }
                
                operationsProcessed++;
                processedOperationIds.push(operation.id);

                // 增加协作点
                if (operationsProcessed % 3 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                
            } catch (error) {
                console.error(`Error applying operation ${operation.id}:`, error);
            }
        }

        // 如果有任何修改，保存索引
        if (operationsProcessed > 0) {
            workingIndex.lastUpdated = Date.now();
            workingIndex.totalCount = workingIndex.files.length;
            
            // 记录最后处理的操作ID
            if (processedOperationIds.length > 0) {
                workingIndex.lastOperationId = processedOperationIds[processedOperationIds.length - 1];
            }

            // 保存更新后的索引（使用分块格式）
            const saveSuccess = await saveChunkedIndex(context, workingIndex);
            if (!saveSuccess) {
                console.error('Failed to save chunked index');
                return {
                    success: false,
                    error: 'Failed to save index'
                };
            }

            console.log(`Index updated: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed, ${movedCount} moved`);
        }

        // 清理已处理的操作记录
        if (cleanupAfterMerge && processedOperationIds.length > 0) {
            await cleanupOperations(context, processedOperationIds);
        }

        // 如果未处理完所有操作，调用 merge-operations API 递归处理
        if (!isALLOperations) {
            console.log('There are remaining operations, will process them in subsequent calls.');

            const headers = new Headers(request.headers);
            const originUrl = new URL(request.url);
            const mergeUrl = `${originUrl.protocol}//${originUrl.host}/api/manage/list?action=merge-operations`;

            await fetch(mergeUrl, { method: 'GET', headers });

            return {
                success: false,
                error: 'There are remaining operations, will process them in subsequent calls.'
            };
        }

        const result = {
            success: true,
            processedOperations: operationsProcessed,
            addedCount,
            updatedCount,
            removedCount,
            movedCount,
            totalFiles: workingIndex.totalCount
        };

        console.log('Operations merge completed:', result);
        return result;

    } catch (error) {
        console.error('Error merging operations:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 读取文件索引，支持搜索和分页
 * @param {Object} context - 上下文对象
 * @param {Object} options - 查询选项
 * @param {string} options.search - 搜索关键字
 * @param {string} options.directory - 目录过滤
 * @param {number} options.start - 起始位置
 * @param {number} options.count - 返回数量，-1 表示返回所有
 * @param {Array<string>|string} options.channel - 渠道过滤（支持数组多选）
 * @param {Array<string>|string} options.listType - 列表类型过滤（支持数组多选）
 * @param {Array<string>|string} options.accessStatus - 访问状态筛选（支持数组多选）：'normal'=正常, 'blocked'=已屏蔽
 * @param {Array<string>|string} options.label - 审查结果筛选（支持数组多选）
 * @param {Array<string>|string} options.fileType - 文件类型筛选（支持数组多选）
 * @param {Array<string>|string} options.channelName - 渠道名称筛选（支持数组多选）
 * @param {Array<string>} options.includeTags - 必须包含的标签数组
 * @param {Array<string>} options.excludeTags - 必须排除的标签数组
 * @param {boolean} options.countOnly - 仅返回总数
 * @param {boolean} options.includeSubdirFiles - 是否包含子目录下的文件
 */
export async function readIndex(context, options = {}) {
    // D1 后端：直接 SQL 查询 files 表，跳过 JSON 索引
    if (isD1Backend(context)) {
        return await readIndexD1(context, options);
    }
    try {
        const {
            search = '',
            directory = '',
            start = 0,
            count = 50,
            channel = [],
            listType = [],
            accessStatus = [],
            label = [],
            fileType = [],
            channelName = [],
            includeTags = [],
            excludeTags = [],
            countOnly = false,
            includeSubdirFiles = false
        } = options;

        // 将参数统一转换为数组形式
        const channelArr = Array.isArray(channel) ? channel : (channel ? [channel] : []);
        const listTypeArr = Array.isArray(listType) ? listType : (listType ? [listType] : []);
        const accessStatusArr = Array.isArray(accessStatus) ? accessStatus : (accessStatus ? [accessStatus] : []);
        const labelArr = Array.isArray(label) ? label : (label ? [label] : []);
        const fileTypeArr = Array.isArray(fileType) ? fileType : (fileType ? [fileType] : []);
        const channelNameArr = Array.isArray(channelName) ? channelName : (channelName ? [channelName] : []);

        // 处理目录满足无头有尾的格式，根目录为空
        const dirPrefix = directory === '' || directory.endsWith('/') ? directory : directory + '/';

        // 处理挂起的操作
        const mergeResult = await mergeOperationsToIndex(context);
        if (!mergeResult.success) {
            throw new Error('Failed to merge operations: ' + mergeResult.error);
        }

        // 获取当前索引
        const index = await getIndex(context);
        if (!index.success) {
            throw new Error('Failed to get index');
        }

        let filteredFiles = index.files;

        // 目录过滤
        if (directory) {
            const normalizedDir = directory.endsWith('/') ? directory : directory + '/';
            filteredFiles = filteredFiles.filter(file => {
                const fileDir = file.metadata.Directory ? file.metadata.Directory : extractDirectory(file.id);
                return fileDir.startsWith(normalizedDir) || file.metadata.Directory === directory;
            });
        }

        // 渠道过滤（支持多选，OR 逻辑）
        if (channelArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => 
                channelArr.some(ch => file.metadata.Channel?.toLowerCase() === ch.toLowerCase())
            );
        }

        // 列表类型过滤（黑白名单，支持多选，OR 逻辑）
        // White=白名单, Block=黑名单, None=未设置
        if (listTypeArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const fileListType = file.metadata.ListType;
                return listTypeArr.some(lt => {
                    if (lt === 'None') {
                        // 未设置：ListType 为空、undefined、null 或字符串 'None'
                        return !fileListType || fileListType === '' || fileListType === 'None';
                    }
                    return fileListType === lt;
                });
            });
        }

        // 访问状态筛选（综合判断 ListType 和 Label，支持多选，OR 逻辑）
        // 'normal' = 正常：非已屏蔽状态
        // 'blocked' = 已屏蔽：ListType === 'Block' || (Label === 'adult' && ListType !== 'White')
        // 注意：白名单优先，即使 Label 是 adult，只要 ListType 是 White 就是正常
        if (accessStatusArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const fileListType = file.metadata.ListType;
                const fileLabel = file.metadata.Label;
                const isBlocked = fileListType === 'Block' || (fileLabel === 'adult' && fileListType !== 'White');

                return accessStatusArr.some(status => {
                    if (status === 'normal') {
                        return !isBlocked;
                    } else if (status === 'blocked') {
                        return isBlocked;
                    }
                    return false;
                });
            });
        }

        // 审查结果筛选 (label)（支持多选，OR 逻辑）
        // 'normal' 匹配 Label 为 'everyone', 'None', '', null, undefined
        // 'teen' 匹配 Label 为 'teen'
        // 'adult' 匹配 Label 为 'adult'
        if (labelArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const fileLabel = file.metadata.Label;
                return labelArr.some(lbl => {
                    if (lbl === 'normal') {
                        return !fileLabel || fileLabel === '' || fileLabel === 'None' || fileLabel === 'everyone';
                    } else if (lbl === 'teen') {
                        return fileLabel === 'teen';
                    } else if (lbl === 'adult') {
                        return fileLabel === 'adult';
                    }
                    return false;
                });
            });
        }

        // 文件类型筛选 (fileType)（支持多选，OR 逻辑）
        // 'image' 匹配 FileType 以 'image/' 开头
        // 'video' 匹配 FileType 以 'video/' 开头
        // 'audio' 匹配 FileType 以 'audio/' 开头
        // 'other' 匹配不属于以上三类的文件
        if (fileTypeArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const mimeType = file.metadata.FileType || '';
                return fileTypeArr.some(ft => {
                    if (ft === 'image') {
                        return mimeType.startsWith('image/');
                    } else if (ft === 'video') {
                        return mimeType.startsWith('video/');
                    } else if (ft === 'audio') {
                        return mimeType.startsWith('audio/');
                    } else if (ft === 'other') {
                        return !mimeType.startsWith('image/') && 
                               !mimeType.startsWith('video/') && 
                               !mimeType.startsWith('audio/');
                    }
                    return false;
                });
            });
        }

        // 渠道名称筛选 (channelName)（支持多选，OR 逻辑）
        // 支持 "type:name" 格式（如 "TelegramNew:default"）或单独的名称
        if (channelNameArr.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const fileChannel = file.metadata.Channel;
                const fileChannelName = file.metadata.ChannelName;

                return channelNameArr.some(filterValue => {
                    // 检查是否是 "type:name" 格式
                    if (filterValue.includes(':')) {
                        const [type, name] = filterValue.split(':', 2);
                        // 同时匹配渠道类型和名称（大小写敏感）
                        return fileChannel === type && fileChannelName === name;
                    } else {
                        // 只匹配名称（向后兼容）
                        return fileChannelName === filterValue;
                    }
                });
            });
        }

        // 标签过滤（独立于搜索关键字）
        if (includeTags.length > 0 || excludeTags.length > 0) {
            filteredFiles = filteredFiles.filter(file => {
                const fileTags = (file.metadata.Tags || []).map(t => t.toLowerCase());

                // 检查必须包含的标签
                if (includeTags.length > 0) {
                    const hasAllIncludeTags = includeTags.every(tag => 
                        fileTags.includes(tag.toLowerCase())
                    );
                    if (!hasAllIncludeTags) {
                        return false;
                    }
                }

                // 检查必须排除的标签
                if (excludeTags.length > 0) {
                    const hasAnyExcludeTag = excludeTags.some(tag => 
                        fileTags.includes(tag.toLowerCase())
                    );
                    if (hasAnyExcludeTag) {
                        return false;
                    }
                }

                return true;
            });
        }

        // 搜索过滤（仅关键字）
        if (search) {
            const searchLower = search.toLowerCase();
            filteredFiles = filteredFiles.filter(file => {
                const matchesKeyword =
                    file.metadata.FileName?.toLowerCase().includes(searchLower) ||
                    file.id.toLowerCase().includes(searchLower);
                return matchesKeyword;
            });
        }

        // 如果只需要总数
        if (countOnly) {
            return {
                totalCount: filteredFiles.length,
                indexLastUpdated: index.lastUpdated
            };
        }

        // 分页处理
        const totalCount = filteredFiles.length;

        let resultFiles = filteredFiles;

        // 计算当前目录下的直接文件（不包含子目录文件）
        const directFiles = filteredFiles.filter(file => {
            const fileDir = file.metadata.Directory ? file.metadata.Directory : extractDirectory(file.id);
            return fileDir === dirPrefix;
        });
        const directFileCount = directFiles.length;

        // 如果不包含子目录文件，获取当前目录下的直接文件
        if (!includeSubdirFiles) {
            resultFiles = directFiles;
        }

        if (count !== -1) {
            const startIndex = Math.max(0, start);
            const endIndex = startIndex + Math.max(1, count);
            resultFiles = resultFiles.slice(startIndex, endIndex);
        }

        // 提取目录信息
        const directories = new Set();
        filteredFiles.forEach(file => {
            const fileDir = file.metadata.Directory ? file.metadata.Directory : extractDirectory(file.id);
            if (fileDir && fileDir.startsWith(dirPrefix)) {
                const relativePath = fileDir.substring(dirPrefix.length);
                const firstSlashIndex = relativePath.indexOf('/');
                if (firstSlashIndex !== -1) {
                    const subDir = dirPrefix + relativePath.substring(0, firstSlashIndex);
                    directories.add(subDir);
                }
            }
        });

        // 直接子文件夹数目
        const directFolderCount = directories.size;

        return {
            files: resultFiles,
            directories: Array.from(directories),
            totalCount: totalCount,
            directFileCount: directFileCount,
            directFolderCount: directFolderCount,
            indexLastUpdated: index.lastUpdated,
            returnedCount: resultFiles.length,
            success: true
        };

    } catch (error) {
        console.error('Error reading index:', error);
        return {
            files: [],
            directories: [],
            totalCount: 0,
            indexLastUpdated: Date.now(),
            returnedCount: 0,
            success: false,
        };
    }
}

/**
 * 重建索引（从数据库中的所有文件重新构建索引）
 * @param {Object} context - 上下文对象
 * @param {Function} progressCallback - 进度回调函数
 */
export async function rebuildIndex(context, progressCallback = null) {
    // D1 后端：无需重建索引，仅清理遗留数据
    if (isD1Backend(context)) {
        return await rebuildIndexD1(context);
    }
    const { env, waitUntil } = context;
    const db = getDatabase(env);

    try {
        console.log('Starting index rebuild...');
        
        let cursor = null;
        let processedCount = 0;
        const newIndex = {
            files: [],
            lastUpdated: Date.now(),
            totalCount: 0,
            lastOperationId: null
        };

        // 分批读取所有文件
        while (true) {
            const response = await db.list({
                limit: KV_LIST_LIMIT,
                cursor: cursor
            });

            cursor = response.cursor;

            for (const item of response.keys) {
                // 跳过管理相关的键
                if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
                    continue;
                }

                // 跳过没有元数据的文件
                if (!item.metadata || !item.metadata.TimeStamp) {
                    continue;
                }

                // 构建文件索引项
                const fileItem = {
                    id: item.name,
                    metadata: item.metadata || {}
                };

                newIndex.files.push(fileItem);
                processedCount++;

                // 报告进度
                if (progressCallback && processedCount % 100 === 0) {
                    progressCallback(processedCount);
                }
            }

            if (!cursor) break;
            
            // 添加协作点
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 按时间戳倒序排序
        newIndex.files.sort((a, b) => b.metadata.TimeStamp - a.metadata.TimeStamp);

        newIndex.totalCount = newIndex.files.length;

        // 保存新索引（使用分块格式）
        const saveSuccess = await saveChunkedIndex(context, newIndex);
        if (!saveSuccess) {
            console.error('Failed to save chunked index during rebuild');
            return {
                success: false,
                error: 'Failed to save rebuilt index'
            };
        }

        // 清除旧的操作记录和多余索引
        waitUntil(deleteAllOperations(context));
        waitUntil(clearChunkedIndex(context, true));


        console.log(`Index rebuild completed. Processed ${processedCount} files, indexed ${newIndex.totalCount} files.`);
        return {
            success: true,
            processedCount,
            indexedCount: newIndex.totalCount
        };
        
    } catch (error) {
        console.error('Error rebuilding index:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 获取索引信息
 * @param {Object} context - 上下文对象
 * @param {Object} options - 统计选项
 */
export async function getIndexInfo(context, options = {}) {
    // D1 后端：SQL 聚合统计
    if (isD1Backend(context)) {
        return await getIndexInfoD1(context, options);
    }
    try {
        const index = await getIndex(context);

        // 检查索引是否成功获取
        if (index.success === false) {
            return {
                success: false,
                error: 'Failed to retrieve index',
                message: 'Index is not available or corrupted'
            }
        }

        // 统计各渠道文件数量
        const channelStats = Object.create(null);
        const directoryStats = Object.create(null);
        const typeStats = Object.create(null);
        const uploadTrend = createUploadTrendAccumulator(index.files, options);
        
        index.files.forEach(file => {
            const metadata = file.metadata || {};

            // 渠道统计
            const channel = normalizeChannel(metadata.Channel);
            incrementStat(channelStats, channel);

            // 目录统计
            const dir = metadata.Directory || extractDirectory(file.id) || '/';
            incrementStat(directoryStats, dir);
            
            // 类型统计
            let listType = metadata.ListType || 'None';
            const label = metadata.Label || 'None';
            if (listType !== 'White' && label === 'adult') {
                listType = 'Block';
            }
            incrementStat(typeStats, listType);

            addUploadTrendPoint(uploadTrend, metadata, channel);
        });

        return {
            success: true,
            totalFiles: index.totalCount,
            lastUpdated: index.lastUpdated,
            channelStats,
            directoryStats,
            typeStats,
            uploadTrend: finalizeUploadTrend(uploadTrend),
            oldestFile: index.files[index.files.length - 1],
            newestFile: index.files[0]
        };
    } catch (error) {
        console.error('Error getting index info:', error);
        return null;
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TREND_MAX_POINTS = 90;
const MAX_TREND_POINTS = 366;
const DEFAULT_TREND_SERIES_LIMIT = 8;
const MAX_TREND_SERIES_LIMIT = 20;

function incrementStat(stats, key) {
    const normalizedKey = normalizeTrendKey(key);
    stats[normalizedKey] = (stats[normalizedKey] || 0) + 1;
}

function normalizeChannel(channel) {
    if (channel === 'TelegramNew') {
        return 'Telegram';
    }
    return normalizeTrendKey(channel, 'Telegraph');
}

function normalizeTrendKey(value, fallback = 'Unknown') {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || fallback;
    }
    if (value === null || value === undefined) {
        return fallback;
    }
    return String(value);
}

function normalizeInteger(value, defaultValue, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return defaultValue;
    }
    return Math.min(max, Math.max(min, parsed));
}

function getLocalDayNumber(timestamp, timezoneOffset) {
    return Math.floor((timestamp - timezoneOffset * 60 * 1000) / DAY_MS);
}

function getValidTimestamp(metadata) {
    const timestamp = Number(metadata?.TimeStamp);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function formatTrendDay(dayNumber) {
    return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function parseTrendDate(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }

    return Math.floor(date.getTime() / DAY_MS);
}

function getTrendDayRange(files, timezoneOffset, options = {}) {
    let newestDay = null;
    let oldestDay = null;
    const optionStartDay = parseTrendDate(options.startDate);
    const optionEndDay = parseTrendDate(options.endDate);

    // The index is maintained in timestamp-desc order, so this avoids sorting.
    for (let i = 0; i < files.length; i++) {
        const timestamp = getValidTimestamp(files[i].metadata);
        if (timestamp !== null) {
            newestDay = getLocalDayNumber(timestamp, timezoneOffset);
            break;
        }
    }

    for (let i = files.length - 1; i >= 0; i--) {
        const timestamp = getValidTimestamp(files[i].metadata);
        if (timestamp !== null) {
            oldestDay = getLocalDayNumber(timestamp, timezoneOffset);
            break;
        }
    }

    if (optionStartDay !== null || optionEndDay !== null) {
        const startDay = optionStartDay !== null ? optionStartDay : (oldestDay !== null ? oldestDay : optionEndDay);
        const endDay = optionEndDay !== null ? optionEndDay : (newestDay !== null ? newestDay : optionStartDay);
        return startDay <= endDay
            ? { startDay, endDay }
            : { startDay: endDay, endDay: startDay };
    }

    if (newestDay === null || oldestDay === null) {
        return null;
    }

    if (oldestDay > newestDay) {
        return { startDay: newestDay, endDay: oldestDay };
    }

    return { startDay: oldestDay, endDay: newestDay };
}

function buildTrendBucketLabels(startDay, endDay, bucketSizeDays, bucketCount) {
    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
        const bucketStartDay = startDay + i * bucketSizeDays;
        const bucketEndDay = Math.min(bucketStartDay + bucketSizeDays - 1, endDay);
        labels.push(bucketStartDay === bucketEndDay
            ? formatTrendDay(bucketStartDay)
            : `${formatTrendDay(bucketStartDay)} - ${formatTrendDay(bucketEndDay)}`);
    }
    return labels;
}

function createUploadTrendAccumulator(files, options) {
    const timezoneOffset = normalizeInteger(options.timezoneOffset, 0, -14 * 60, 14 * 60);
    const maxPoints = normalizeInteger(options.maxPoints, DEFAULT_TREND_MAX_POINTS, 7, MAX_TREND_POINTS);
    const seriesLimit = normalizeInteger(options.seriesLimit, DEFAULT_TREND_SERIES_LIMIT, 1, MAX_TREND_SERIES_LIMIT);
    const range = getTrendDayRange(files, timezoneOffset, options);

    if (!range) {
        return {
            enabled: false,
            timezoneOffset,
            maxPoints,
            seriesLimit
        };
    }

    const spanDays = range.endDay - range.startDay + 1;
    const bucketSizeDays = Math.max(1, Math.ceil(spanDays / maxPoints));
    const bucketCount = Math.ceil(spanDays / bucketSizeDays);

    return {
        enabled: true,
        timezoneOffset,
        maxPoints,
        seriesLimit,
        startDay: range.startDay,
        endDay: range.endDay,
        bucketSizeDays,
        bucketCount,
        labels: buildTrendBucketLabels(range.startDay, range.endDay, bucketSizeDays, bucketCount),
        total: Array(bucketCount).fill(0),
        channelGroups: new Map(),
        channelNameGroups: new Map()
    };
}

function addUploadTrendPoint(accumulator, metadata, channel) {
    if (!accumulator.enabled) {
        return;
    }

    const timestamp = getValidTimestamp(metadata);
    if (timestamp === null) {
        return;
    }

    const dayNumber = getLocalDayNumber(timestamp, accumulator.timezoneOffset);
    const bucketIndex = Math.floor((dayNumber - accumulator.startDay) / accumulator.bucketSizeDays);
    if (bucketIndex < 0 || bucketIndex >= accumulator.bucketCount) {
        return;
    }

    const channelName = normalizeTrendKey(metadata.ChannelName, channel);

    accumulator.total[bucketIndex] += 1;
    addTrendGroupPoint(accumulator.channelGroups, channel, bucketIndex);
    addTrendGroupPoint(accumulator.channelNameGroups, channelName, bucketIndex);
}

function addTrendGroupPoint(groups, key, bucketIndex, count = 1) {
    const normalizedKey = normalizeTrendKey(key);
    let entry = groups.get(normalizedKey);
    if (!entry) {
        entry = {
            total: 0,
            buckets: new Map()
        };
        groups.set(normalizedKey, entry);
    }

    entry.total += count;
    entry.buckets.set(bucketIndex, (entry.buckets.get(bucketIndex) || 0) + count);
}

function buildTrendSeries(groups, bucketCount, seriesLimit) {
    const selectedEntries = selectTopTrendEntries(groups, seriesLimit);
    const selectedNames = new Set(selectedEntries.map(([name]) => name));
    const series = selectedEntries.map(([name, entry]) => ({
        name,
        total: entry.total,
        data: buildTrendSeriesData(entry, bucketCount)
    }));

    if (groups.size > selectedEntries.length) {
        const otherData = Array(bucketCount).fill(0);
        let otherTotal = 0;

        for (const [name, entry] of groups.entries()) {
            if (selectedNames.has(name)) {
                continue;
            }
            otherTotal += entry.total;
            entry.buckets.forEach((count, bucketIndex) => {
                otherData[bucketIndex] += count;
            });
        }

        series.push({
            name: '__other__',
            isOther: true,
            total: otherTotal,
            data: otherData
        });
    }

    return {
        series,
        totalSeries: groups.size,
        limited: groups.size > selectedEntries.length
    };
}

function selectTopTrendEntries(groups, seriesLimit) {
    const topEntries = [];

    for (const entry of groups.entries()) {
        insertTopTrendEntry(topEntries, entry, seriesLimit);
    }

    return topEntries;
}

function insertTopTrendEntry(topEntries, candidate, seriesLimit) {
    let insertIndex = -1;

    for (let i = 0; i < topEntries.length; i++) {
        if (compareTrendEntry(candidate, topEntries[i]) < 0) {
            insertIndex = i;
            break;
        }
    }

    if (insertIndex === -1) {
        if (topEntries.length < seriesLimit) {
            topEntries.push(candidate);
        }
        return;
    }

    topEntries.splice(insertIndex, 0, candidate);
    if (topEntries.length > seriesLimit) {
        topEntries.pop();
    }
}

function compareTrendEntry(left, right) {
    if (right[1].total !== left[1].total) {
        return right[1].total - left[1].total;
    }
    return left[0].localeCompare(right[0]);
}

function buildTrendSeriesData(entry, bucketCount) {
    const data = Array(bucketCount).fill(0);
    entry.buckets.forEach((count, bucketIndex) => {
        data[bucketIndex] = count;
    });
    return data;
}

function finalizeUploadTrend(accumulator) {
    const emptyGroup = {
        series: [],
        totalSeries: 0,
        limited: false
    };

    if (!accumulator.enabled) {
        return {
            labels: [],
            total: [],
            bucketSizeDays: 1,
            maxPoints: accumulator.maxPoints,
            seriesLimit: accumulator.seriesLimit,
            range: null,
            groupBy: {
                channel: emptyGroup,
                channelName: emptyGroup
            }
        };
    }

    return {
        labels: accumulator.labels,
        total: accumulator.total,
        bucketSizeDays: accumulator.bucketSizeDays,
        maxPoints: accumulator.maxPoints,
        seriesLimit: accumulator.seriesLimit,
        range: {
            startDate: formatTrendDay(accumulator.startDay),
            endDate: formatTrendDay(accumulator.endDay),
            timezoneOffset: accumulator.timezoneOffset
        },
        groupBy: {
            channel: buildTrendSeries(accumulator.channelGroups, accumulator.bucketCount, accumulator.seriesLimit),
            channelName: buildTrendSeries(accumulator.channelNameGroups, accumulator.bucketCount, accumulator.seriesLimit)
        }
    };
}

/**
 * 获取索引元数据（轻量级，只读取 meta，不读取整个索引）
 * 用于容量检查等场景，避免读取整个索引
 * @param {Object} context - 上下文对象
 * @returns {Object} 索引元数据，包含 totalCount, totalSizeMB, channelStats 等
 */
export async function getIndexMeta(context) {
    // D1 后端：SQL 实时统计
    if (isD1Backend(context)) {
        return await getIndexMetaD1(context);
    }
    const { env } = context;
    const db = getDatabase(env);

    try {
        const metadataStr = await db.get(INDEX_META_KEY);
        if (!metadataStr) {
            return {
                success: false,
                totalCount: 0,
                totalSizeMB: 0,
                channelStats: {}
            };
        }

        const metadata = JSON.parse(metadataStr);
        return {
            success: true,
            totalCount: metadata.totalCount || 0,
            totalSizeMB: metadata.totalSizeMB || 0,
            channelStats: metadata.channelStats || {},
            lastUpdated: metadata.lastUpdated
        };
    } catch (error) {
        console.error('Error getting index meta:', error);
        return {
            success: false,
            totalCount: 0,
            totalSizeMB: 0,
            channelStats: {}
        };
    }
}

/* ============= 原子操作相关函数 ============= */

/**
 * 生成唯一的操作ID
 */
function generateOperationId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `${timestamp}_${random}`;
}

/**
 * 记录原子操作
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @param {string} type - 操作类型
 * @param {Object} data - 操作数据
 */
async function recordOperation(context, type, data) {
    const { env } = context;
    const db = getDatabase(env);

    const operationId = generateOperationId();
    const operation = {
        type,
        timestamp: Date.now(),
        data
    };
    
    const operationKey = OPERATION_KEY_PREFIX + operationId;
    await db.put(operationKey, JSON.stringify(operation));

    return operationId;
}

/**
 * 获取所有待处理的操作
 * @param {Object} context - 上下文对象
 * @param {string} lastOperationId - 最后处理的操作ID
 */
async function getAllPendingOperations(context, lastOperationId = null) {
    const { env } = context;
    const db = getDatabase(env);

    const operations = [];

    let cursor = null;
    const MAX_OPERATION_COUNT = 30; // 单次获取的最大操作数量
    let isALL = true; // 是否获取了所有操作
    let operationCount = 0;

    try {
        while (true) {
            const response = await db.list({
                prefix: OPERATION_KEY_PREFIX,
                limit: KV_LIST_LIMIT,
                cursor: cursor
            });
            
            for (const item of response.keys) {
                // 如果指定了lastOperationId，跳过已处理的操作
                if (lastOperationId && item.name <= OPERATION_KEY_PREFIX + lastOperationId) {
                    continue;
                }
                
                if (operationCount >= MAX_OPERATION_COUNT) {
                    isALL = false; // 达到最大操作数量，停止获取
                    break;
                }

                try {
                    const operationData = await db.get(item.name);
                    if (operationData) {
                        const operation = JSON.parse(operationData);
                        operation.id = item.name.substring(OPERATION_KEY_PREFIX.length);
                        operations.push(operation);
                        operationCount++;
                    }
                } catch (error) {
                    isALL = false;
                    console.warn(`Failed to parse operation ${item.name}:`, error);
                }
            }
            
            cursor = response.cursor;
            if (!cursor || operationCount >= MAX_OPERATION_COUNT) break;
        }
    } catch (error) {
        console.error('Error getting pending operations:', error);
    }
    
    return {
        operations,
        isAll: isALL,
    }
}

/**
 * 应用添加操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyAddOperation(index, data) {
    const { fileId, metadata } = data;
    
    // 检查文件是否已存在
    const existingIndex = index.files.findIndex(file => file.id === fileId);
    
    const fileItem = {
        id: fileId,
        metadata: metadata || {}
    };
    
    if (existingIndex !== -1) {
        // 更新现有文件
        index.files[existingIndex] = fileItem;
        return { added: false, updated: true };
    } else {
        // 添加新文件
        insertFileInOrder(index.files, fileItem);
        return { added: true, updated: false };
    }
}

/**
 * 应用删除操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyRemoveOperation(index, data) {
    const { fileId } = data;
    const initialLength = index.files.length;
    index.files = index.files.filter(file => file.id !== fileId);
    return index.files.length < initialLength;
}

/**
 * 应用移动操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyMoveOperation(index, data) {
    const { originalFileId, newFileId, metadata } = data;
    
    const originalIndex = index.files.findIndex(file => file.id === originalFileId);
    if (originalIndex === -1) {
        return false; // 原文件不存在
    }
    
    // 更新文件ID和元数据
    index.files[originalIndex] = {
        id: newFileId,
        metadata: metadata || index.files[originalIndex].metadata
    };
    
    return true;
}

/**
 * 应用批量添加操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyBatchAddOperation(index, data) {
    const { files, options } = data;
    const { skipExisting = false } = options || {};
    
    let addedCount = 0;
    let updatedCount = 0;
    
    // 创建现有文件ID的映射以提高查找效率
    const existingFilesMap = new Map();
    index.files.forEach((file, idx) => {
        existingFilesMap.set(file.id, idx);
    });
    
    for (const fileData of files) {
        const { fileId, metadata } = fileData;
        const fileItem = {
            id: fileId,
            metadata: metadata || {}
        };
        
        const existingIndex = existingFilesMap.get(fileId);
        
        if (existingIndex !== undefined) {
            if (!skipExisting) {
                // 更新现有文件
                index.files[existingIndex] = fileItem;
                updatedCount++;
            }
        } else {
            // 添加新文件
            insertFileInOrder(index.files, fileItem);
            // 更新映射
            index.files.forEach((file, idx) => {
                existingFilesMap.set(file.id, idx);
            });
            
            addedCount++;
        }
    }
    
    return { addedCount, updatedCount };
}

/**
 * 应用批量删除操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyBatchRemoveOperation(index, data) {
    const { fileIds } = data;
    const fileIdSet = new Set(fileIds);
    const initialLength = index.files.length;
    
    index.files = index.files.filter(file => !fileIdSet.has(file.id));
    
    return initialLength - index.files.length;
}

/**
 * 应用批量移动操作
 * @param {Object} index - 索引对象
 * @param {Object} data - 操作数据
 */
function applyBatchMoveOperation(index, data) {
    const { operations } = data;
    let movedCount = 0;
    
    // 创建现有文件ID的映射以提高查找效率
    const existingFilesMap = new Map();
    index.files.forEach((file, idx) => {
        existingFilesMap.set(file.id, idx);
    });
    
    for (const operation of operations) {
        const { originalFileId, newFileId, metadata } = operation;
        
        const originalIndex = existingFilesMap.get(originalFileId);
        if (originalIndex !== undefined) {
            // 更新映射
            existingFilesMap.delete(originalFileId);
            existingFilesMap.set(newFileId, originalIndex);
            
            // 更新文件信息
            index.files[originalIndex] = {
                id: newFileId,
                metadata: metadata || index.files[originalIndex].metadata
            };
            
            movedCount++;
        }
    }
    
    return movedCount;
}

/**
 * 并发清理指定的原子操作记录
 * @param {Object} context - 上下文对象
 * @param {Array} operationIds - 要清理的操作ID数组
 * @param {number} concurrency - 并发数量，默认为10
 */
async function cleanupOperations(context, operationIds, concurrency = 10) {
    const { env } = context;
    const db = getDatabase(env);

    try {
        console.log(`Cleaning up ${operationIds.length} processed operations with concurrency ${concurrency}...`);
        
        let deletedCount = 0;
        let errorCount = 0;
        
        // 创建删除任务数组
        const deleteTasks = operationIds.map(operationId => {
            const operationKey = OPERATION_KEY_PREFIX + operationId;
            return async () => {
                try {
                    await db.delete(operationKey);
                    deletedCount++;
                } catch (error) {
                    console.error(`Error deleting operation ${operationId}:`, error);
                    errorCount++;
                }
            };
        });
        
        // 使用并发控制执行删除操作
        await promiseLimit(deleteTasks, concurrency);

        console.log(`Successfully cleaned up ${deletedCount} operations, ${errorCount} operations failed.`);
        return {
            success: true,
            deletedCount: deletedCount,
            errorCount: errorCount,
        };

    } catch (error) {
        console.error('Error cleaning up operations:', error);
    }
}

/**
 * 删除所有原子操作记录
 * @param {Object} context - 上下文对象，包含 env 和其他信息
 * @returns {Object} 删除结果 { success, deletedCount, errors?, totalFound? }
 */
export async function deleteAllOperations(context) {
    // D1 后端：一条 SQL 清空所有操作记录
    if (isD1Backend(context)) {
        try {
            await d1Run(context, 'DELETE FROM index_operations');
            console.log('D1 SQL mode: all operations deleted');
            return {
                success: true,
                deletedCount: 0,
                totalFound: 0,
                message: 'No operations to delete'
            };
        } catch (error) {
            console.error('Error deleting all operations (D1 SQL):', error);
        }
        return;
    }
    const { request, env } = context;
    const db = getDatabase(env);
    
    try {
        console.log('Starting to delete all atomic operations...');
        
        // 获取所有原子操作
        const allOperationIds = [];
        let cursor = null;
        let totalFound = 0;
        
        // 首先收集所有操作键
        while (true) {
            const response = await db.list({
                prefix: OPERATION_KEY_PREFIX,
                limit: KV_LIST_LIMIT,
                cursor: cursor
            });
            
            for (const item of response.keys) {
                allOperationIds.push(item.name.substring(OPERATION_KEY_PREFIX.length));
                totalFound++;
            }
            
            cursor = response.cursor;
            if (!cursor) break;
        }
        
        if (totalFound === 0) {
            console.log('No atomic operations found to delete');
            return {
                success: true,
                deletedCount: 0,
                totalFound: 0,
                message: 'No operations to delete'
            };
        }
        
        console.log(`Found ${totalFound} atomic operations to delete`);

        // 限制单次删除的数量
        const MAX_DELETE_BATCH = 40;
        const toDeleteOperationIds = allOperationIds.slice(0, MAX_DELETE_BATCH);
   
        // 批量删除原子操作
        const cleanupResult = await cleanupOperations(context, toDeleteOperationIds);

        // 剩余未删除的操作，调用 delete-operations API 进行递归删除
        if (allOperationIds.length > MAX_DELETE_BATCH || cleanupResult.errorCount > 0) {
            console.warn(`Too many operations (${allOperationIds.length}), only deleting first ${cleanupResult.deletedCount}. The remaining operations will be deleted in subsequent calls.`);
            // 复制请求头，用于鉴权
            const headers = new Headers(request.headers);

            const originUrl = new URL(request.url);
            const deleteUrl = `${originUrl.protocol}//${originUrl.host}/api/manage/list?action=delete-operations`
            
            await fetch(deleteUrl, {
                method: 'GET',
                headers: headers
            });

        } else {
            console.log(`Delete all operations completed`);
        }

    } catch (error) {
        console.error('Error deleting all operations:', error);
    }
}

/* ============= 工具函数 ============= */

/**
 * 获取索引（内部函数）
 * @param {Object} context - 上下文对象
 */
async function getIndex(context) {
    const { waitUntil } = context;
    try {
        // 首先尝试加载分块索引
        const index = await loadChunkedIndex(context);
        if (index.success) {
            return index;
        } else {
            // 如果加载失败，触发重建索引
            waitUntil(rebuildIndex(context));
        }
    } catch (error) {
        console.warn('Error reading index, creating new one:', error);
        waitUntil(rebuildIndex(context));
    }
    
    // 返回空的索引结构
    return {
        files: [],
        lastUpdated: Date.now(),
        totalCount: 0,
        lastOperationId: null,
        success: false,
    };
}

/**
 * 从文件路径提取目录（内部函数）
 * @param {string} filePath - 文件路径
 */
function extractDirectory(filePath) {
    const lastSlashIndex = filePath.lastIndexOf('/');
    if (lastSlashIndex === -1) {
        return ''; // 根目录
    }
    return filePath.substring(0, lastSlashIndex + 1); // 包含最后的斜杠
}

/**
 * 将扁平目录路径列表转换为嵌套树结构
 * @param {Array<string>} directories - 目录路径数组，如 ['photos/', 'photos/2024/', 'documents/']
 * @returns {Object} 树形结构 { name, path, children }
 * 
 * 示例输出：
 * {
 *   name: "/",
 *   path: "",
 *   children: [
 *     {
 *       name: "photos",
 *       path: "photos/",
 *       children: [
 *         { name: "2024", path: "photos/2024/", children: [] }
 *       ]
 *     },
 *     { name: "documents", path: "documents/", children: [] }
 *   ]
 * }
 */
function buildTree(directories) {
    // 创建根节点
    const root = {
        name: "/",
        path: "",
        children: []
    };

    // 如果没有目录，返回仅包含根节点的空树
    if (!directories || directories.length === 0) {
        return root;
    }

    // 使用 Map 存储已创建的节点，key 为路径
    const nodeMap = new Map();
    nodeMap.set("", root);

    // 对目录进行排序，确保父目录在子目录之前处理
    const sortedDirs = [...directories].sort();

    for (const dirPath of sortedDirs) {
        // 跳过空路径（根目录已创建）
        if (!dirPath) continue;

        // 规范化路径：确保以 / 结尾
        const normalizedPath = dirPath.endsWith('/') ? dirPath : dirPath + '/';

        // 如果节点已存在，跳过
        if (nodeMap.has(normalizedPath)) continue;

        // 分割路径获取各级目录名
        const parts = normalizedPath.split('/').filter(part => part !== '');

        // 逐级创建节点
        let currentPath = "";
        let parentNode = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currentPath = currentPath + part + '/';

            // 检查当前路径的节点是否已存在
            if (nodeMap.has(currentPath)) {
                parentNode = nodeMap.get(currentPath);
            } else {
                // 创建新节点
                const newNode = {
                    name: part,
                    path: currentPath,
                    children: []
                };

                // 添加到父节点的 children 中
                parentNode.children.push(newNode);

                // 存储到 Map 中
                nodeMap.set(currentPath, newNode);

                // 更新父节点引用
                parentNode = newNode;
            }
        }
    }

    // 对每个节点的 children 按名称排序
    const sortChildren = (node) => {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
        node.children.forEach(sortChildren);
    };
    sortChildren(root);

    return root;
}



/**
 * 将文件按时间戳倒序插入到已排序的数组中
 * @param {Array} sortedFiles - 已按时间戳倒序排序的文件数组
 * @param {Object} fileItem - 要插入的文件项
 */
function insertFileInOrder(sortedFiles, fileItem) {
    const fileTimestamp = fileItem.metadata.TimeStamp || 0;
    
    // 如果数组为空或新文件时间戳比第一个文件更新，直接插入到开头
    if (sortedFiles.length === 0 || fileTimestamp >= (sortedFiles[0].metadata.TimeStamp || 0)) {
        sortedFiles.unshift(fileItem);
        return;
    }
    
    // 如果新文件时间戳比最后一个文件更旧，直接添加到末尾
    if (fileTimestamp <= (sortedFiles[sortedFiles.length - 1].metadata.TimeStamp || 0)) {
        sortedFiles.push(fileItem);
        return;
    }
    
    // 使用二分查找找到正确的插入位置
    let left = 0;
    let right = sortedFiles.length;
    
    while (left < right) {
        const mid = Math.floor((left + right) / 2);
        const midTimestamp = sortedFiles[mid].metadata.TimeStamp || 0;
        
        if (fileTimestamp >= midTimestamp) {
            right = mid;
        } else {
            left = mid + 1;
        }
    }
    
    // 在找到的位置插入文件
    sortedFiles.splice(left, 0, fileItem);
}

/**
 * 并发控制工具函数 - 限制同时执行的Promise数量
 * @param {Array} tasks - 任务数组，每个任务是一个返回Promise的函数
 * @param {number} concurrency - 并发数量
 * @returns {Promise<Array>} 所有任务的结果数组
 */
async function promiseLimit(tasks, concurrency = BATCH_SIZE) {
    const results = [];
    const executing = [];
    
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const promise = Promise.resolve().then(() => task()).then(result => {
            results[i] = result;
            return result;
        }).finally(() => {
            const index = executing.indexOf(promise);
            if (index >= 0) {
                executing.splice(index, 1);
            }
        });
        
        executing.push(promise);
        
        if (executing.length >= concurrency) {
            await Promise.race(executing);
        }
    }
    
    // 等待所有剩余的Promise完成
    await Promise.all(executing);
    return results;
}

/**
 * 保存分块索引到数据库
 * @param {Object} context - 上下文对象，包含 env
 * @param {Object} index - 完整的索引对象
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveChunkedIndex(context, index) {
    const { env } = context;
    const db = getDatabase(env);
    const chunkSize = getIndexChunkSize(env);
    
    try {
        const files = index.files || [];
        const chunks = [];
        
        // 将文件数组分块
        for (let i = 0; i < files.length; i += chunkSize) {
            const chunk = files.slice(i, i + chunkSize);
            chunks.push(chunk);
        }
        
        // 计算各渠道容量统计
        const channelStats = {};
        let totalSizeMB = 0;
        
        for (const file of files) {
            const channelName = file.metadata?.ChannelName;
            const fileSize = parseFloat(file.metadata?.FileSize) || 0;
            
            totalSizeMB += fileSize;
            
            if (channelName) {
                if (!channelStats[channelName]) {
                    channelStats[channelName] = { usedMB: 0, fileCount: 0 };
                }
                channelStats[channelName].usedMB += fileSize;
                channelStats[channelName].fileCount += 1;
            }
        }
        
        // 保存索引元数据（包含容量统计）
        const metadata = {
            lastUpdated: index.lastUpdated,
            totalCount: index.totalCount,
            totalSizeMB: Math.round(totalSizeMB * 100) / 100,
            channelStats,
            lastOperationId: index.lastOperationId,
            chunkCount: chunks.length,
            chunkSize: chunkSize
        };
        
        await db.put(INDEX_META_KEY, JSON.stringify(metadata));
        
        // 保存各个分块
        const savePromises = chunks.map((chunk, chunkId) => {
            const chunkKey = `${INDEX_KEY}_${chunkId}`;
            return db.put(chunkKey, JSON.stringify(chunk));
        });
        
        await Promise.all(savePromises);
        
        console.log(`Saved chunked index: ${chunks.length} chunks, ${files.length} total files, ${totalSizeMB.toFixed(2)} MB`);
        return true;
        
    } catch (error) {
        console.error('Error saving chunked index:', error);
        return false;
    }
}

/**
 * 从数据库加载分块索引
 * @param {Object} context - 上下文对象，包含 env
 * @returns {Promise<Object>} 完整的索引对象
 */
async function loadChunkedIndex(context) {
    const { env } = context;
    const db = getDatabase(env);

    try {
        // 首先获取元数据
        const metadataStr = await db.get(INDEX_META_KEY);
        if (!metadataStr) {
            throw new Error('Index metadata not found');
        }
        
        const metadata = JSON.parse(metadataStr);
        const files = [];
        
        // 并行加载所有分块
        const loadPromises = [];
        for (let chunkId = 0; chunkId < metadata.chunkCount; chunkId++) {
            const chunkKey = `${INDEX_KEY}_${chunkId}`;
            loadPromises.push(
                db.get(chunkKey).then(chunkStr => {
                    if (chunkStr) {
                        return JSON.parse(chunkStr);
                    }
                    return [];
                })
            );
        }
        
        const chunks = await Promise.all(loadPromises);
        
        // 合并所有分块
        chunks.forEach(chunk => {
            if (Array.isArray(chunk)) {
                files.push(...chunk);
            }
        });
        
        const index = {
            files,
            lastUpdated: metadata.lastUpdated,
            totalCount: metadata.totalCount,
            lastOperationId: metadata.lastOperationId,
            success: true
        };
        
        console.log(`Loaded chunked index: ${metadata.chunkCount} chunks, ${files.length} total files`);
        return index;
        
    } catch (error) {
        console.error('Error loading chunked index:', error);
        // 返回空的索引结构
        return {
            files: [],
            lastUpdated: Date.now(),
            totalCount: 0,
            lastOperationId: null,
            success: false,
        };
    }
}

/**
 * 清理分块索引
 * @param {Object} context - 上下文对象，包含 env
 * @param {boolean} onlyNonUsed - 是否仅清理未使用的分块索引，默认为 false
 * @returns {Promise<boolean>} 是否清理成功
 */
export async function clearChunkedIndex(context, onlyNonUsed = false) {
    const { env } = context;
    const db = getDatabase(env);
    
    try {
        console.log('Starting chunked index cleanup...');
        
        // 获取元数据
        const metadataStr = await db.get(INDEX_META_KEY);
        let chunkCount = 0;
        
        if (metadataStr) {
            const metadata = JSON.parse(metadataStr);
            chunkCount = metadata.chunkCount || 0;

            if (!onlyNonUsed) {
                // 删除元数据
                await db.delete(INDEX_META_KEY).catch(() => {});
            }
        }

        // 删除分块
        const recordedChunks = []; // 现有的索引分块键
        let cursor = null;
        while (true) {
            const response = await db.list({
                prefix: INDEX_KEY,
                limit: KV_LIST_LIMIT,
                cursor: cursor
            });
            
            for (const item of response.keys) {
                recordedChunks.push(item.name);
            }

            cursor = response.cursor;
            if (!cursor) break;
        }

        const reservedChunks = [];
        if (onlyNonUsed) {
            // 如果仅清理未使用的分块索引，保留当前在使用的分块
            for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
                reservedChunks.push(`${INDEX_KEY}_${chunkId}`);
            }
        }

        const deletePromises = [];
        for (let chunkKey of recordedChunks) {
            if (reservedChunks.includes(chunkKey) || !chunkKey.startsWith(INDEX_KEY + '_')) {
                // 保留的分块和非分块键不删除
                continue;
            }

            deletePromises.push(
                db.delete(chunkKey).catch(() => {})
            );
        }

        if (recordedChunks.includes(INDEX_KEY)) {
            deletePromises.push(
                db.delete(INDEX_KEY).catch(() => {})
            );
        }

        await Promise.all(deletePromises);
        
        console.log(`Chunked index cleanup completed. Attempted to delete ${chunkCount} chunks.`);
        return true;
        
    } catch (error) {
        console.error('Error during chunked index cleanup:', error);
        return false;
    }
}

/**
 * 获取索引的存储统计信息
 * @param {Object} context - 上下文对象，包含 env
 * @returns {Object} 存储统计信息
 */
export async function getIndexStorageStats(context) {
    // D1 后端：无分块索引，返回实时统计
    if (isD1Backend(context)) {
        const countRow = await d1First(context, `SELECT COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER}`).catch(() => null);
        return {
            success: true,
            isChunked: false,
            mode: 'd1-sql',
            metadata: { totalCount: countRow?.c || 0 },
            chunks: [],
            totalChunks: 0,
            existingChunks: 0,
            totalSize: 0
        };
    }
    const { env } = context;
    const db = getDatabase(env);

    try {
        // 获取元数据
        const metadataStr = await db.get(INDEX_META_KEY);
        if (!metadataStr) {
            return {
                success: false,
                error: 'No chunked index metadata found',
                isChunked: false
            };
        }
        
        const metadata = JSON.parse(metadataStr);
        
        // 检查各个分块的存在情况
        const chunkChecks = [];
        for (let chunkId = 0; chunkId < metadata.chunkCount; chunkId++) {
            const chunkKey = `${INDEX_KEY}_${chunkId}`;
            chunkChecks.push(
                db.get(chunkKey).then(data => ({
                    chunkId,
                    exists: !!data,
                    size: data ? data.length : 0
                }))
            );
        }
        
        const chunkResults = await Promise.all(chunkChecks);
        
        const stats = {
            success: true,
            isChunked: true,
            metadata,
            chunks: chunkResults,
            totalChunks: metadata.chunkCount,
            existingChunks: chunkResults.filter(c => c.exists).length,
            totalSize: chunkResults.reduce((sum, c) => sum + c.size, 0)
        };
        
        return stats;
        
    } catch (error) {
        console.error('Error getting index storage stats:', error);
        return {
            success: false,
            error: error.message,
            isChunked: false
        };
    }
}



/**
 * 从索引中提取目录树结构
 * @param {Object} context - 上下文对象
 * @returns {Object} 树形结构 { name, path, children }
 */
export async function getDirectoryTree(context) {
    // D1 后端：SQL 查询目录
    if (isD1Backend(context)) {
        return await getDirectoryTreeD1(context);
    }
    // 1. 合并挂起操作
    await mergeOperationsToIndex(context);

    // 2. 获取索引
    const index = await getIndex(context);

    // 3. 提取所有目录路径
    const directorySet = new Set();

    if (index.files && index.files.length > 0) {
        for (const file of index.files) {
            // 获取文件的目录路径
            const dirPath = file.metadata?.Directory || extractDirectory(file.id);

            if (dirPath) {
                // 规范化路径：确保以 / 结尾
                const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';

                // 将路径按 / 分割，逐级添加到目录集合中（确保父目录也被包含）
                const parts = normalizedDir.split('/').filter(part => part !== '');
                let currentPath = '';

                for (const part of parts) {
                    currentPath = currentPath + part + '/';
                    directorySet.add(currentPath);
                }
            }
        }
    }

    // 4. 构建树形结构
    const directories = Array.from(directorySet);
    return buildTree(directories);
}

/* ============= 随机文件 / 上传IP统计（D1 SQL 模式） ============= */

/**
 * 随机获取一个符合条件的文件记录
 * D1 后端通过 SQL ORDER BY RANDOM() 直接选取，避免全量读取；
 * KV 后端保留原有"全量读取 + JS 过滤"逻辑
 * @param {Object} context - 上下文对象
 * @param {Object} options - 查询选项
 * @param {string} options.directory - 目录（不含尾部斜杠）
 * @param {Array<string>} options.fileTypes - 文件类型关键字（如 ['image']）
 * @param {string} options.orientation - 图片方向（landscape/portrait/square/空）
 * @returns {Promise<{name: string, FileType: string, Width: number, Height: number}|null>}
 */
export async function queryRandomFile(context, options = {}) {
    const { directory = '', fileTypes = [], orientation = '' } = options;
    const dirPrefix = directory && !directory.endsWith('/') ? directory + '/' : directory;

    if (isD1Backend(context)) {
        try {
            const filter = buildD1FileFilter({ accessStatus: ['normal'] });
            const conditions = [filter.where];
            const params = [...filter.params];

            const recursiveDir = buildD1DirectoryCond(dirPrefix, 'recursive');
            if (recursiveDir.cond) {
                conditions.push(recursiveDir.cond);
                params.push(...recursiveDir.params);
            }

            const fileTypesArr = Array.isArray(fileTypes) ? fileTypes.filter((t) => t) : [];
            if (fileTypesArr.length > 0) {
                const parts = fileTypesArr.map((type) => {
                    params.push(`%${escapeLike(type)}%`);
                    return "file_type LIKE ? ESCAPE '\\'";
                });
                conditions.push(`(${parts.join(' OR ')})`);
            }

            const widthExpr = "CAST(json_extract(metadata, '$.Width') AS REAL)";
            const heightExpr = "CAST(json_extract(metadata, '$.Height') AS REAL)";
            if (orientation === 'landscape') {
                conditions.push(`(${widthExpr} > ${heightExpr} * 1.1)`);
            } else if (orientation === 'portrait') {
                conditions.push(`(${widthExpr} < ${heightExpr} * 0.9)`);
            } else if (orientation === 'square') {
                conditions.push(`(${widthExpr} >= ${heightExpr} * 0.9 AND ${widthExpr} <= ${heightExpr} * 1.1)`);
            }

            const row = await d1First(
                context,
                `SELECT id AS name, json_extract(metadata, '$.FileType') AS FileType, json_extract(metadata, '$.Width') AS Width, json_extract(metadata, '$.Height') AS Height FROM files WHERE ${conditions.join(' AND ')} ORDER BY RANDOM() LIMIT 1`,
                params
            );
            return row || null;
        } catch (error) {
            console.error('Error querying random file (D1 SQL):', error);
            return null;
        }
    }

    // KV 后端：保留原有逻辑（全量读取 + JS 过滤）
    const result = await readIndex(context, { directory, count: -1, includeSubdirFiles: true, accessStatus: 'normal' });
    let records = result.files || [];

    const fileTypesArr = Array.isArray(fileTypes) ? fileTypes.filter((t) => t) : [];
    if (fileTypesArr.length > 0) {
        records = records.filter((item) => fileTypesArr.some((type) => item.metadata?.FileType?.includes(type)));
    }

    if (orientation && records.length > 0) {
        const SQUARE_THRESHOLD = 0.1;
        records = records.filter((item) => {
            if (!item.metadata?.Width || !item.metadata?.Height) return false;
            const ratio = item.metadata.Width / item.metadata.Height;
            switch (orientation) {
                case 'landscape':
                    return ratio > (1 + SQUARE_THRESHOLD);
                case 'portrait':
                    return ratio < (1 - SQUARE_THRESHOLD);
                case 'square':
                    return ratio >= (1 - SQUARE_THRESHOLD) && ratio <= (1 + SQUARE_THRESHOLD);
                default:
                    return true;
            }
        });
    }

    if (records.length === 0) {
        return null;
    }

    const picked = records[Math.floor(Math.random() * records.length)];
    return {
        name: picked.id,
        FileType: picked.metadata?.FileType,
        Width: picked.metadata?.Width,
        Height: picked.metadata?.Height,
    };
}

/**
 * 按上传 IP 统计文件数量（管理端 IP 统计列表）
 * @param {Object} context - 上下文对象
 * @param {number} start - 分页起始位置
 * @param {number} count - 返回数量
 * @returns {Promise<Array<{ip: string, address: string, count: number}>>}
 */
export async function listUploadIPStats(context, start = 0, count = 10) {
    start = Math.max(0, start);
    count = Math.max(1, count);

    if (isD1Backend(context)) {
        try {
            return await d1All(
                context,
                `SELECT upload_ip AS ip, COALESCE(NULLIF(upload_address, ''), '未知') AS address, COUNT(*) AS count FROM files WHERE ${D1_BASE_FILE_FILTER} AND upload_ip IS NOT NULL AND upload_ip <> '' GROUP BY upload_ip ORDER BY count DESC, ip LIMIT ? OFFSET ?`,
                [count, start]
            );
        } catch (error) {
            console.error('Error listing upload IP stats (D1 SQL):', error);
            return [];
        }
    }

    // KV 后端：保留原有逻辑
    const allRecords = await readIndex(context, { count: -1, includeSubdirFiles: true });
    const groups = new Map();
    for (const item of allRecords.files || []) {
        const ip = item.metadata?.UploadIP;
        if (!ip) continue;

        const group = groups.get(ip);
        if (group) {
            group.count++;
            continue;
        }

        groups.set(ip, {
            ip,
            address: item.metadata?.UploadAddress || '未知',
            count: 1,
        });
    }

    return Array.from(groups.values())
        .sort((a, b) => b.count - a.count)
        .slice(start, start + count);
}

/**
 * 按上传 IP 查询文件列表（管理端 IP 统计详情）
 * @param {Object} context - 上下文对象
 * @param {string} ip - 上传 IP
 * @param {number} start - 分页起始位置
 * @param {number} count - 返回数量
 * @returns {Promise<{files: Array<{id: string, metadata: Object}>, total: number}>}
 */
export async function listFilesByUploadIP(context, ip, start = 0, count = 20) {
    start = Math.max(0, start);
    count = Math.max(1, count);

    if (isD1Backend(context)) {
        try {
            const [rows, totalRow] = await Promise.all([
                d1All(
                    context,
                    `SELECT id, metadata FROM files WHERE ${D1_BASE_FILE_FILTER} AND upload_ip = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
                    [ip, count, start]
                ),
                d1First(
                    context,
                    `SELECT COUNT(*) AS c FROM files WHERE ${D1_BASE_FILE_FILTER} AND upload_ip = ?`,
                    [ip]
                ),
            ]);
            return {
                files: rows.map((row) => ({ id: row.id, metadata: parseMetadata(row.metadata) })),
                total: totalRow?.c || 0,
            };
        } catch (error) {
            console.error('Error listing files by upload IP (D1 SQL):', error);
            return { files: [], total: 0 };
        }
    }

    // KV 后端：保留原有逻辑
    const allRecords = await readIndex(context, { count: -1, includeSubdirFiles: true });
    const matching = (allRecords.files || []).filter((item) => item.metadata?.UploadIP === ip);
    return {
        files: matching.slice(start, start + count),
        total: matching.length,
    };
}
