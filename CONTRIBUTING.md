# 参与开发

提交问题时请描述 Zotero/Harness 版本、操作步骤及实际结果；演示文献可以用于复现。

```powershell
npm test
npm run test:bridge
npm run build
```

保持稳定来源 ID 与单一归档写入方；界面修改不要触发已有内容重新生成。新增模型调用请使用可模拟的 HarnessModel 边界。运行凭据、工作缓存、真实论文和个人笔记不放进提交。
