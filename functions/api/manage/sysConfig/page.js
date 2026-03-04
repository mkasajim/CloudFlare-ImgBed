import { getDatabase } from '../../../utils/databaseAdapter.js';

export async function onRequest(context) {
    // 页面设置相关，GET方法读取设置，POST方法保存设置
    const {
        request, // same as existing Worker API
        env, // same as existing Worker API
        params, // if filename includes [id] or [[path]]
        waitUntil, // same as ctx.waitUntil in existing Worker API
        next, // used for middleware or to fetch assets
        data, // arbitrary space for passing data between middlewares
    } = context;

    const db = getDatabase(env);

    // GET读取设置
    if (request.method === 'GET') {
        const settings = await getPageConfig(db, env)

        return new Response(JSON.stringify(settings), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // POST保存设置
    if (request.method === 'POST') {
        const body = await request.json()
        const settings = body
        // 写入数据库
        await db.put('manage@sysConfig@page', JSON.stringify(settings))

        return new Response(JSON.stringify(settings), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

}

export async function getPageConfig(db, env) {
    const settings = {}
    // 读取数据库中的设置
    const settingsStr = await db.get('manage@sysConfig@page')
    const settingsKV = settingsStr ? JSON.parse(settingsStr) : {}

    const config = []
    settings.config = config
    config.push(
        // Global Settings
        {
            id: 'siteTitle',
            label: 'Site Title',
            placeholder: 'Sanyue ImgHub',
            category: 'Global Settings',
        },
        {
            id: 'siteIcon',
            label: 'Site Icon',
            category: 'Global Settings',
        },
        {
            id: 'ownerName',
            label: 'Image Host Name',
            placeholder: 'Sanyue ImgHub',
            category: 'Global Settings',
        },
        {
            id: 'logoUrl',
            label: 'Image Host Logo',
            category: 'Global Settings',
        },
        {
            id: 'logoLink',
            label: 'Logo Link URL',
            placeholder: 'https://github.com/MarSeventh/CloudFlare-ImgBed',
            tooltip: 'URL to open when clicking logo. Leave blank to use default GitHub link.',
            category: 'Global Settings',
        },
        {
            id: 'bkInterval',
            label: 'Background Switch Interval',
            placeholder: '3000',
            tooltip: 'Unit: milliseconds (ms)',
            category: 'Global Settings',
        },
        {
            id: 'bkOpacity',
            label: 'Background Opacity',
            placeholder: '1',
            tooltip: 'Decimal between 0 and 1',
            category: 'Global Settings',
        },
        {
            id: 'urlPrefix',
            label: 'Default URL Prefix',
            tooltip: 'Custom URL prefix, e.g. https://img.a.com/file/. Leave blank to use current domain.<br/>Applies to client and admin UI.',
            category: 'Global Settings',
        },
        // Client Settings
        {
            id: 'announcement',
            label: 'Announcement',
            type: 'textarea',
            tooltip: 'HTML supported',
            category: 'Client Settings',
        },
        {
            id: 'showDirectorySuggestions',
            label: 'Directory Suggestions',
            type: 'boolean',
            default: true,
            tooltip: 'Control whether to show the directory tree selector on upload page',
            category: 'Client Settings',
        },
        {
            id: 'defaultUploadChannel',
            label: 'Default Channel Type',
            type: 'select',
            options: [
                { label: 'Telegram', value: 'telegram' },
                { label: 'Cloudflare R2', value: 'cfr2' },
                { label: 'S3', value: 's3' },
                { label: 'Discord', value: 'discord' },
                { label: 'HuggingFace', value: 'huggingface' },
            ],
            placeholder: 'telegram',
            category: 'Client Settings',
        },
        {
            id: 'defaultChannelName',
            label: 'Default Channel Name',
            type: 'channelName',
            tooltip: 'Set default channel name (select channel type first)',
            category: 'Client Settings',
        },
        {
            id: 'defaultUploadFolder',
            label: 'Default Upload Directory',
            placeholder: 'Valid directory starting with /. No special characters. Default is root.',
            category: 'Client Settings',
        },
        {
            id: 'defaultUploadNameType',
            label: 'Default Naming Mode',
            type: 'select',
            options: [
                { label: 'Default', value: 'default' },
                { label: 'Prefix only', value: 'index' },
                { label: 'Original name only', value: 'origin' },
                { label: 'Short link', value: 'short' },
            ],
            placeholder: 'default',
            category: 'Client Settings',
        },
        {
            id: 'defaultConvertToWebp',
            label: 'Convert to WebP by default',
            type: 'boolean',
            default: false,
            tooltip: 'Convert images to WebP before upload to reduce size',
            category: 'Client Settings',
        },
        {
            id: 'defaultCustomerCompress',
            label: 'Compression enabled by default',
            type: 'boolean',
            default: true,
            tooltip: 'Compress locally before upload (images only)',
            category: 'Client Settings',
        },
        {
            id: 'defaultCompressBar',
            label: 'Default Compression Threshold',
            placeholder: '5',
            tooltip: 'Auto-compress when image exceeds this size (MB), range 1-20',
            category: 'Client Settings',
        },
        {
            id: 'defaultCompressQuality',
            label: 'Default Compression Target',
            placeholder: '4',
            tooltip: 'Expected size after compression (MB), range 0.5 to threshold',
            category: 'Client Settings',
        },
        {
            id: 'loginBkImg',
            label: 'Login Page Background',
            tooltip: '1. Use `bing` for Bing wallpaper carousel <br/>2. Use ["url1","url2"] for multi-image carousel <br/>3. Use ["url"] for single image',
            category: 'Client Settings',
        },
        {
            id: 'uploadBkImg',
            label: 'Upload Page Background',
            tooltip: '1. Use `bing` for Bing wallpaper carousel <br/>2. Use ["url1","url2"] for multi-image carousel <br/>3. Use ["url"] for single image',
            category: 'Client Settings',
        },
        {
            id: 'footerLink',
            label: 'Footer Link',
            category: 'Client Settings',
        },
        {
            id: 'disableFooter',
            label: 'Hide Footer',
            type: 'boolean',
            default: false,
            category: 'Client Settings',
        },
        // Admin Settings
        {
            id: 'adminLoginBkImg',
            label: 'Login Page Background',
            tooltip: '1. Use `bing` for Bing wallpaper carousel <br/>2. Use ["url1","url2"] for multi-image carousel <br/>3. Use ["url"] for single image',
            category: 'Admin Settings',
        },
        {
            id: 'adminBkImg',
            label: 'Admin Page Background',
            tooltip: '1. Use `bing` for Bing wallpaper carousel <br/>2. Use ["url1","url2"] for multi-image carousel <br/>3. Use ["url"] for single image',
            category: 'Admin Settings',
        },
    )

    const userConfig = env.USER_CONFIG
    if (userConfig) {
        try {
            const parsedConfig = JSON.parse(userConfig)
            if (typeof parsedConfig === 'object' && parsedConfig !== null) {
                // 搜索config中的id，如果存在则更新
                for (let i = 0; i < config.length; i++) {
                    if (parsedConfig[config[i].id]) {
                        config[i].value = parsedConfig[config[i].id]
                    }
                }
            }
        } catch (error) {
            // do nothing
        }
    }

    // 用KV中的设置覆盖Default设置
    for (let i = 0; i < settingsKV.config?.length; i++) {
        const item = settingsKV.config[i]
        const index = config.findIndex(x => x.id === item.id)
        if (index !== -1) {
            config[index].value = item.value
        }
    }

    return settings
}