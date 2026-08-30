import { listFilesByUploadIP } from "../../../utils/indexManager";
import { getDatabase } from "../../../utils/databaseAdapter.js";
import { buildFileMetadataForManagement, createMetadataViewContext } from "../../../utils/metadata/metadataView.js";

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip');
    let start = parseInt(url.searchParams.get('start'), 10) || 0;
    let count = parseInt(url.searchParams.get('count'), 10) || 20;

    if (!ip) {
        return new Response(JSON.stringify({ error: 'Missing ip parameter' }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
        });
    }

    start = Math.max(0, start);
    count = Math.max(1, count);

    const db = getDatabase(context.env);
    const metadataViewContext = await createMetadataViewContext(db, context.env);

    // 按上传 IP 查询文件（D1 后端走 SQL 分页，KV 后端走索引过滤）
    const { files, total } = await listFilesByUploadIP(context, ip, start, count);

    const data = await Promise.all(files.map(async item => ({
        ...item,
        metadata: await buildFileMetadataForManagement(db, context.env, item.metadata, metadataViewContext)
    })));

    return new Response(JSON.stringify({
        data,
        total,
    }), {
        headers: { "Content-Type": "application/json" }
    });
}
