# 灵感库

浏览网页时，在图片上右键「保存到灵感库」。图片和来源写进这台电脑的 `inbox/`，之后可以在 Cursor 里分析。

保存下来的不一定是站点原图。插件会在这张图的 `srcset`、常见大图属性和父链接里挑看起来更大的地址。若先下到的文件比后面那个地址标的尺寸更小，会再试下一张，最后留下像素更大的那张。宽或高小于 480 的，会标成缩略图。看构图、色彩和版式，一张能看清的图就够。

## 启动收集服务

服务只监听这台电脑的 `127.0.0.1:3921`。终端关掉后保存会失败，需要时再开一次。

```bash
cd "/Users/mengli/Documents/自媒体/灵感库/collector"
npm start
```

看到「灵感库收集服务已启动」就可以用了。浏览器打开 [http://127.0.0.1:3921/](http://127.0.0.1:3921/) 能平铺看到全部采集。端口已被占用时，多半是服务已经在跑。

## 安装 Chrome 插件

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选中这个目录：`/Users/mengli/Documents/自媒体/灵感库/extension`

在网页图片上右键，选「保存到灵感库」。先出现备注框，可以不填，点保存后才会真正保存；取消则不保存。页面上方会提示正在保存、保存成功或保存失败。改完插件后，到 `chrome://extensions` 点一次重新加载。点工具栏图标可以看服务是否在线，并打开采集页。

## 一条素材

```text
inbox/2026-10-29/143012_ab12cd/
  source.webp
  meta.json
```

`meta.json` 里分析先空着：

| 字段 | 含义 |
| --- | --- |
| `status` | 固定是 `inbox`，表示还没整理 |
| `source.clickedUrl` | 右键点到的地址 |
| `source.savedUrl` | 实际保存的地址 |
| `source.pageUrl` / `pageTitle` / `alt` | 页面和图片说明 |
| `source.mime` / `width` / `height` | 文件类型和像素。量不出尺寸时宽高是 `null` |
| `source.likelyThumbnail` | 宽或高小于 480 时为 `true` |
| `files.image` | 图片文件名 |
| `note` | 保存前写的备注。没写就是空字符串 |
| `contentHash` | 文件内容的 SHA-256，同一张图不会再存一份 |
| `analysis` | 现在是 `null` |

`inbox/` 只在本机使用，不进入 git。

## 以后在 Cursor 里分析

让 Cursor 看 `inbox/` 里 `analysis` 还是 `null` 的条目。判断画面时读图片文件，并结合 `pageTitle`、`savedUrl`、`width`、`height` 和 `likelyThumbnail`。标成缩略图的可以跳过，或只当作线索。分析写在该条目旁边，不要改图片字节。
