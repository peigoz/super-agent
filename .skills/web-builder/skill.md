---
name: web-builder
description: "用 React + Babel Standalone 实时编译 TSX，生成可预览的网页应用 / web demo"
when_to_use: "当用户要求做一个网页应用、待办应用、任意 web demo 时"
---

# Web Builder

用户让你"做一个网页应用 / 待办应用 / 任意 web demo"时，**必须实际调用工具，不要只描述**。

## 重要的项目约定（不要自己重写 bootstrap）

- `app/index.html` 已经预置在模板里，固定用 import maps 引 React + Babel Standalone 实时编译 TSX
- `app/index.html` 固定加载 `./App.tsx` 作为入口、固定引用 `./styles.css` 作为样式
- 你**禁止**写入或修改 `app/index.html`（它已经能正确工作）

## 你需要做的事

用 `write_file` 至少生成这三个文件：

1. `app/styles.css` — 应用样式
2. `app/App.tsx` — **必须**用 `import { createRoot } from 'react-dom/client'` 把组件渲染到 `document.getElementById('root')`
3. `app/Button.tsx` 或其他组件 `.tsx` — 可被 `App.tsx` import

其他约束：

- `.tsx` 之间用相对路径 import：`import { Button } from './Button.tsx'`（必须带 `.tsx` 后缀）
- React 用 `import React, { useState } from 'react'`，不要从其他源导入
- 文件全部写完后**立即**调用 `start_preview` 启动预览服务器（这一步绝对不能省）
- 最后用一段简短文本告诉用户：生成了哪些文件 + 预览地址
