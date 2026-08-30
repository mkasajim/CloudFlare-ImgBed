import { fetchOthersConfig } from "../utils/sysConfig";
import { queryRandomFile } from "../utils/indexManager";
import { detectDevice, resolveOrientation, addClientHintsHeaders } from "./adaptive.js";

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

let othersConfig = {};
let allowRandom = false;

export async function onRequest(context) {
    // Contents of context object
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;
    const requestUrl = new URL(request.url);

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // 读取其他设置
    othersConfig = await fetchOthersConfig(env);
    allowRandom = othersConfig.randomImageAPI.enabled;
    const allowedDir = othersConfig.randomImageAPI.allowedDir;

    // 检查是否启用了随机图功能
    if (allowRandom != true) {
        return new Response(JSON.stringify({ error: "Random is disabled" }), { status: 403, headers: corsHeaders });
    }

    // 处理允许的目录，每个目录调整为标准格式，去掉首尾空格，去掉开头的/，替换多个连续的/为单个/，去掉末尾的/
    const allowedDirList = allowedDir.split(',');
    const allowedDirListFormatted = allowedDirList.map(item => {
        return item.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    });

    // 从params中读取返回的文件类型
    let fileType = requestUrl.searchParams.get('content');
    if (fileType == null) {
        fileType = ['image'];
    } else {
        fileType = fileType.split(',');
    }

    // 读取图片方向参数：landscape(横图), portrait(竖图), square(方图), auto(自适应)
    const orientationParam = requestUrl.searchParams.get('orientation') || '';

    // 根据参数值决定行为
    const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];
    let orientation = '';
    let isAutoMode = false;

    if (VALID_ORIENTATIONS.includes(orientationParam)) {
        // 手动指定有效方向，直接使用
        orientation = orientationParam;
    } else if (orientationParam === 'auto') {
        // 自适应模式：检测设备并自动决策
        isAutoMode = true;
        const deviceInfo = detectDevice(request);
        orientation = resolveOrientation(deviceInfo);
    }
    // 其他情况（未指定或无效值）：orientation 保持空字符串，不过滤

    // 读取指定文件夹
    const paramDir = requestUrl.searchParams.get('dir') || '';
    const dir = paramDir.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');

    // 检查是否在允许的目录中，或是允许目录的子目录
    let dirAllowed = false;
    for (let i = 0; i < allowedDirListFormatted.length; i++) {
        if (allowedDirListFormatted[i] === '' || dir === allowedDirListFormatted[i] || dir.startsWith(allowedDirListFormatted[i] + '/')) {
            dirAllowed = true;
            break;
        }
    }
    if (!dirAllowed) {
        return new Response(JSON.stringify({ error: "Directory not allowed" }), { status: 403, headers: corsHeaders });
    }

    // 直接通过数据库查询随机文件（D1 后端走 SQL 随机选取，KV 后端走索引过滤）
    let randomKey = await queryRandomFile(context, { directory: dir, fileTypes: fileType, orientation });

    // 自适应模式降级：带方向过滤无匹配图片时，降级到全部图片
    if (!randomKey && isAutoMode && orientation) {
        randomKey = await queryRandomFile(context, { directory: dir, fileTypes: fileType, orientation: '' });
    }

    // 构建响应头：添加 CORS 跨域响应头，自适应模式下添加 Client Hints 协商头
    const responseHeaders = new Headers(corsHeaders);
    if (isAutoMode) {
        addClientHintsHeaders(responseHeaders);
    }

    if (randomKey == null) {
        return new Response(JSON.stringify({}), { status: 200, headers: responseHeaders });
    } else {
        const randomPath = '/file/' + randomKey.name;
        let randomUrl = randomPath;

        const randomType = requestUrl.searchParams.get('type');
        const resType = requestUrl.searchParams.get('form');
        
        // if param 'type' is set to 'url', return the full URL
        if (randomType == 'url') {
            randomUrl = requestUrl.origin + randomPath;
        }

        // if param 'type' is set to 'img', return the image
        if (randomType == 'img') {
            // Return an image response
            randomUrl = requestUrl.origin + randomPath;
            let contentType = 'image/jpeg';
            const imgHeaders = new Headers(responseHeaders);
            return new Response(await fetch(randomUrl).then(res => {
                contentType = res.headers.get('content-type');
                return res.blob();
            }), {
                headers: (() => {
                    imgHeaders.set('Content-Type', contentType || 'image/jpeg');
                    return imgHeaders;
                })(),
                status: 200
            });
        }
        
        if (resType == 'text') {
            return new Response(randomUrl, { status: 200, headers: responseHeaders });
        } else {
            return new Response(JSON.stringify({ url: randomUrl }), { status: 200, headers: responseHeaders });
        }
    }
}