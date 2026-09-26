# 墨匣 · 网页版（构建产物）

这是 [墨匣](https://github.com/Umamed26/novel-editor)（小说创作编辑器）的**网页版构建产物**，
由 GitHub Pages 直接托管；**源码不在这个仓库**，源码仓库当前是私有的。

- 打开站点：https://umamed26.github.io/novel-editor-web/
- 稿件数据全部存在**你自己的浏览器**里（IndexedDB），服务端只有静态文件，
  没有账号、没有云同步；换设备或清缓存不会跟着走 —— 常用「导出全部备份」留一份。
- 这个仓库里的文件由 `pnpm web:build` + `scripts/publish-pages.py` 生成并发布，
  请勿手工修改（下次发布会整体覆盖）。

许可：代码 [MIT](https://github.com/Umamed26/novel-editor/blob/master/LICENSE) © 2026 墨匣 contributors；
品牌视觉素材版权归作者本人所有（见源码仓库的 `NOTICE`）。
