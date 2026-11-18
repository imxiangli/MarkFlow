# MarkFlow 快捷键

快捷键沿用 Sublime Text 4 的默认键位，并按 Markdown 编辑的需要做了少量调整。本文由 `npm run docs:shortcuts` 根据 `src/shared/keybindings.ts` 生成，请勿手工修改。

- **组合键**：`⌘K` / `Ctrl+K` 是组合键前缀。先按 `⌘K`，状态提示出现后再按第二个键（例如 `⌘K ⌘U` 转为大写）。2.5 秒内未按第二个键或按 Esc 会取消。
- **命令面板**：`⇧⌘P` / `Ctrl+Shift+P` 可按名称搜索并执行所有命令，每条命令右侧都显示它的快捷键。
- **Goto Anything**（`⌘P` / `Ctrl+P`）：直接输入文件名打开文件；`文件名:行号` 打开并跳到该行，`文件名@标题` 跳到该文件的标题；以 `:` 开头跳到当前文档的行，`@` 跳到当前文档的标题，`#` 搜索文件夹内所有文档的标题，`>` 执行命令。
- 编辑类命令作用于当前获得焦点的编辑器，包括阅读模式下双击打开的块编辑器；书签、查找下一个、跳回等在阅读模式下同样可用。
- 与 Sublime 不同的几处：插入链接为 `⌥⌘K`（`⌘K` 让给组合键）；macOS 上 `⌘1–9` 切换标签页，标题改为 `⌃⌘1–6`；阅读 / 编辑切换为 `⌥⌘E`（`⌘E` 为“用所选内容查找”）；`⌘R` 跳转到标题。

## 文件

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 新建文件 | ⌘N | Ctrl+N |
| 新建窗口 | ⇧⌘N | Ctrl+Shift+N |
| 打开文件… | ⌘O | Ctrl+O |
| 打开文件夹… | ⇧⌘O | Ctrl+Shift+O |
| 保存 | ⌘S | Ctrl+S |
| 另存为… | ⇧⌘S | Ctrl+Shift+S |
| 全部保存 | ⌥⌘S | Ctrl+Alt+S |
| 打印… | ⌥⌘P | Ctrl+Alt+P |
| 关闭标签页 | ⌘W | Ctrl+W |
| 关闭窗口 | ⇧⌘W | Ctrl+Shift+W |
| 重新打开关闭的标签页 | ⇧⌘T | Ctrl+Shift+T |
| 设置… | ⌘, | Ctrl+, |

## 编辑

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 撤销 | ⌘Z | Ctrl+Z |
| 重做 | ⇧⌘Z | Ctrl+Y |
| 软撤销（撤销选区变化） | ⌘U | Ctrl+U |
| 全选 | ⌘A | Ctrl+A |
| 粘贴并匹配缩进 | ⇧⌘V | Ctrl+Shift+V |

## 行

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 增加缩进 | ⌘\] | Ctrl+\] |
| 减少缩进 | ⌘\[ | Ctrl+\[ |
| 上移行 | ⌃⌘↑ | Ctrl+Shift+Up |
| 下移行 | ⌃⌘↓ | Ctrl+Shift+Down |
| 复制行 / 选区 | ⇧⌘D | Ctrl+Shift+D |
| 删除行 | ⌃⇧K | Ctrl+Shift+K |
| 合并行 | ⌘J | Ctrl+J |

## 文本

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 在下方插入行 | ⌘↩ | Ctrl+Enter |
| 在上方插入行 | ⇧⌘↩ | Ctrl+Shift+Enter |
| 删除到行尾 | ⌘K ⌘K | Ctrl+K Ctrl+K |
| 删除到行首 | ⌘⌫ | Ctrl+K Ctrl+Backspace |
| 切换注释 | ⌘/ | Ctrl+/ |
| 切换块注释 | ⌥⌘/ | Ctrl+Shift+/ |
| 转为大写 | ⌘K ⌘U | Ctrl+K Ctrl+U |
| 转为小写 | ⌘K ⌘L | Ctrl+K Ctrl+L |
| 排序行 | F5 | F9 |
| 排序行（区分大小写） | ⌃F5 | Ctrl+F9 |

## 代码折叠

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 折叠 | ⌥⌘\[ | Ctrl+Shift+\[ |
| 展开 | ⌥⌘\] | Ctrl+Shift+\] |
| 全部展开 | ⌘K ⌘0 或 ⌘K ⌘J | Ctrl+K Ctrl+0 或 Ctrl+K Ctrl+J |
| 折叠到第 1–6 级标题 | ⌘K ⌘1 … ⌘K ⌘6 | Ctrl+K Ctrl+1 … Ctrl+K Ctrl+6 |

## 选择

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 拆分为多行光标 | ⇧⌘L | Ctrl+Shift+L |
| 在上一行添加光标 | ⌃⇧↑ | Ctrl+Alt+Up |
| 在下一行添加光标 | ⌃⇧↓ | Ctrl+Alt+Down |
| 选中行 | ⌘L | Ctrl+L |
| 扩展选区到括号 | ⌃⇧M | Ctrl+Shift+M |
| 扩展选区到缩进 | ⇧⌘J | Ctrl+Shift+J |
| 扩展选区到语法范围 | ⇧⌘Space | Ctrl+Shift+Space |

## 查找

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 查找 | ⌘F | Ctrl+F |
| 查找下一个 | ⌘G | F3 |
| 查找上一个 | ⇧⌘G | Shift+F3 |
| 替换… | ⌥⌘F | Ctrl+H |
| 快速查找 | ⌥⌘G | Ctrl+F3 |
| 选中所有相同项 | ⌃⌘G | Alt+F3 |
| 选中下一个相同项 | ⌘D | Ctrl+D |
| 跳过当前项 | ⌘K ⌘D | Ctrl+K Ctrl+D |
| 用所选内容查找 | ⌘E | Ctrl+E |
| 在文件夹中搜索 | ⇧⌘F | Ctrl+Shift+F |
| 查找：切换正则表达式（焦点在查找框时） | ⌥⌘R | Alt+R |
| 查找：切换区分大小写（焦点在查找框时） | ⌥⌘C | Alt+C |
| 查找：切换全字匹配（焦点在查找框时） | ⌥⌘W | Alt+W |

## 转到

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 快速打开… | ⌘P | Ctrl+P |
| 命令面板… | ⇧⌘P | Ctrl+Shift+P |
| 跳转到标题… | ⌘R | Ctrl+R |
| 在文件夹中跳转到标题… | ⇧⌘R | Ctrl+Shift+R |
| 跳转到行… | ⌃G | Ctrl+G |
| 后退 | ⌃- | Alt+- |
| 前进 | ⌃⇧- | Alt+Shift+- |
| 跳到匹配的括号 | ⌃M | Ctrl+M |
| 下一个标签页 | ⌥⌘→ 或 ⇧⌘\] 或 ⌃⇥ | Ctrl+PageDown 或 Ctrl+Tab |
| 上一个标签页 | ⌥⌘← 或 ⇧⌘\[ 或 ⌃⇧⇥ | Ctrl+PageUp 或 Ctrl+Shift+Tab |
| 切换到第 1–9 个标签页 | ⌘1 … ⌘9 | Alt+1 … Alt+9 |

## 书签

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 添加 / 取消书签 | ⌘F2 | Ctrl+F2 |
| 下一个书签 | F2 | F2 |
| 上一个书签 | ⇧F2 | Shift+F2 |
| 清除全部书签 | ⇧⌘F2 | Ctrl+Shift+F2 |

## 显示

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 切换侧边栏 | ⌘\\ 或 ⌘K ⌘B | Ctrl+\\ 或 Ctrl+K Ctrl+B |
| 文件 | ⇧⌘E | Ctrl+Shift+E |
| 阅读模式 | ⌥⌘1 | Ctrl+Alt+1 或 Alt+Shift+1 |
| 编辑模式 | ⌥⌘2 | Ctrl+Alt+2 或 Alt+Shift+2 |
| 分栏模式 | ⌥⌘3 | Ctrl+Alt+3 或 Alt+Shift+3 |
| 切换阅读/编辑 | ⌥⌘E | Ctrl+Alt+E |
| 专注模式 | ⌃⇧⌘F | Shift+F11 |

## 格式

| 命令 | macOS | Windows / Linux |
| --- | --- | --- |
| 加粗 | ⌘B | Ctrl+B |
| 斜体 | ⌘I | Ctrl+I |
| 删除线 | ⇧⌘X | Ctrl+Shift+X |
| 行内代码 | ⌃\` | Ctrl+\` |
| 超链接 | ⌥⌘K | Ctrl+Alt+K |
| 标题 1–6 | ⌃⌘1 … ⌃⌘6 | Ctrl+1 … Ctrl+6 |
| 引用 | ⌥⌘Q | Ctrl+Alt+Q |
| 无序列表 | ⌥⌘U | Ctrl+Alt+U |
| 有序列表 | ⌥⌘O | Ctrl+Alt+O |
| 任务列表 | ⌥⌘X | Ctrl+Alt+X |
| 代码块 | ⌥⌘C | Ctrl+Alt+C |
| 表格 | ⌥⌘T | Ctrl+Alt+T |
| 公式块 | ⌥⌘B | Ctrl+Alt+B |
