# 微光 · AI 生图

在手机或桌面浏览器打开 [微光](https://vinisdiao1-lang.github.io/mobile-image-studio/)，填入自己的新宝 API Key，选择模型后提交提示词。参考图接受公网 HTTP(S) 图片链接。可用任务 ID 继续查询。

Key 保存在当前页面的内存中。API 转发服务通过 HTTPS 接收请求，并转发到新宝固定的生图和任务查询接口。

## 本地运行

使用 Node.js 22 或更高版本。项目没有第三方 npm 依赖。

```sh
npm run check
npm start
```

访问 `http://127.0.0.1:4317/`。

## 发布

推送 `main` 后，GitHub Actions 将 `site/` 发布到 GitHub Pages。修改 API 时，在腾讯云同步 `server.mjs`、`package.json` 和 `site/models.js` 到 `/home/ubuntu/mobile-image-studio/`，然后重启 `mobile-image-studio.service`。系统服务和 Nginx 路由配置见 `deploy/`。代理监听本地 4317 端口，由 `new.linlangai88.cn` 的 `/mobile-image-api/` 路由提供 HTTPS。
