# 超星/学习通 · 课程 PPT 批量导出（油猴脚本）

一键扫描当前课程**所有章节**的课件附件，批量下载 PPT 原文件（.pptx / .ppt 等）。

- 脚本文件：`超星课程PPT批量导出.user.js`
- 适用页面：超星「学生学习」页 `mooc1.chaoxing.com/mycourse/studentstudy?...`

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（油猴）扩展；
2. 打开 Tampermonkey 面板 →「添加新脚本」→ 全选删掉模板 → 粘贴 `超星课程PPT批量导出.user.js` 全文 → Ctrl+S 保存（或把该文件拖进浏览器，油猴会弹安装页）；
3. 打开课程的学习页面，刷新，页面右上角会出现深色面板「PPT 批量导出」。

## 使用

1. 点「扫描全部章节」——脚本会逐章请求 `knowledge/cards` 页面，抽出每章插入的课件（PPT/PDF/Word…）；
2. 列表默认**只显示 PPT 且已全选**（关掉「仅PPT」可看到 PDF/Word 等附件）；
3. 点「下载选中」，等进度跑完即可；单章文件失败时点该行的 `↗` 可手动下载；
4. 「复制清单 / 导出清单」可留存一份章节↔课件对照表（TSV / JSON）。

扫描结果按 `courseId` 缓存在 `localStorage`，下次进页面不用重扫；换课程或课件更新时点「扫描全部章节」刷新。

## 原理（都是页面本身在用的接口）

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 章节列表 | DOM `#coursetree .posCatalog_select[id^=cur]` | `id` 去掉 `cur` 就是 `knowledgeId` |
| 章节课件 | `/mooc-ans/knowledge/cards?clazzid=&courseid=&knowledgeid=&num=…` | 返回 HTML，解析 `iframe[insertdoc]` 的 `data` JSON（含 `objectid`、`name`、`type`、`size`） |
| 下载地址 | `/ananas/status/{objectid}?flag=normal` | 返回 `{status:"success",download:"…",filename:"…"}`，`download` 即原文件直链 |
| 落盘 | `GM_download`（跨域、带 Cookie） | 文件名 = `章节号_章节名__原文件名` |

## 已知限制

- **图片型课件导不出**：老师把 PPT 按页转成图片插入时，页面里只有图片、没有原文件，脚本会标注「课件以图片形式插入，无原文件可下」。
- **老师关闭了下载**：附件 `download="0"` 时 `status` 可能不给直链，会下载失败，只能在线看。
- **Chrome 多文件下载提示**：首次批量下载时浏览器会问「是否允许本站下载多个文件」，选允许即可。
- 并发默认 3 路，间隔 150–250ms，避免触发超星限流；想更快改脚本顶部 `CFG.parallel`（不建议 >5）。
- 只监听 `studentstudy` 页面；若课程用的是「新版学习页」域名，脚本会因找不到 `#coursetree` 而不显示面板。

## 自测

```bash
# 用保存下来的页面快照（学生学习页面_files/cards.html）离线验证解析逻辑
node test/test_userscript.js
```

> 快照文件体积大，已在 `.gitignore` 里排除；没有快照时跳过自测即可。

## 回滚

油猴面板里删除/禁用该脚本即可；脚本不改动页面业务数据，只发 GET 请求，无写入操作。
