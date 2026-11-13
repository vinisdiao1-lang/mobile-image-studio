# 密码象 · AI 生图

在手机或桌面浏览器打开 [密码象（腾讯云）](https://new.linlangai88.cn/mobile-image-studio/)，填入 API Key，选择模型后提交提示词。模型旁显示每张图的参考积分。[GitHub Pages 版](https://vinisdiao1-lang.github.io/mobile-image-studio/) 也可访问。

每次提交会新增一个任务。上一张图生成时，可以修改提示词或参数并继续提交。各任务独立显示状态、结果和下载按钮，也可用任务 ID 继续查询。

在电脑上将图片拖入生成表单，或在手机上点「＋ 参考图」从相册选择。参考图文件和公网 HTTP(S) 链接合计最多 6 张。浏览器将图片长边缩至最多 1600 像素，提交时生成供生图服务读取的临时链接，1 小时后失效。

Key 保存在当前浏览器，可在设置中更换或清除。任务列表保存在当前页面的内存中。API 转发服务通过 HTTPS 接收请求并调用生图和任务查询接口。

顶部显示与任务看板使用同一账单接口的剩余积分。设置 Key、切换视图和返回页面时会查询，页面可见时每 20 秒更新，也可点余额手动刷新。点击「任务看板」在站内打开任务中心并沿用已保存的 Key。

## 本地运行

使用 Node.js 22 或更高版本。项目没有第三方 npm 依赖。

```sh
npm run check
npm start
```

访问 `http://127.0.0.1:4317/`。

## 发布

腾讯云发布时，将 `site/` 发布为 `/var/www/mobile-image-studio/` 下的新版本目录，并将 `current` 链接切到该版本。Nginx 通过 `deploy/mobile-image-api.conf` 里的路径提供页面和同域 API。仅修改前端时，无需重启 API 服务。

修改 API 时，在腾讯云同步 `server.mjs`、`package.json` 和 `site/models.js` 到 `/home/ubuntu/mobile-image-studio/`，然后重启 `mobile-image-studio.service`。代理监听本地 4317 端口，由 `new.linlangai88.cn` 的 `/mobile-image-api/` 路由提供 HTTPS。

推送 `main` 后，GitHub Actions 将 `site/` 发布到 GitHub Pages。浏览器按域名保存 Key，切换域名时需重新设置一次。
