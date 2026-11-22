# 终端字体选择

## 已选组合

- 英文、数字与代码：`Ubuntu Sans Mono`。
- 中文与中文标点：`MiSans Regular`。

MiSans 采用小米自有的免费商用许可，详见 [官方许可协议](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf) 。

## Tarmac App 内置字体

Tarmac 的终端格子尺寸按 Ubuntu Sans Mono 调整，中文用 MiSans，其他系统一般没有这两种字体，所以 App 自带字体文件，不依赖系统安装（2026-11-19 起）。

- 文件在 `apps/desktop/assets/fonts/`：`ubuntu-sans-mono.ttf`、`ubuntu-sans-mono-italic.ttf`、`ubuntu.ttf`（界面文字）、`misans-regular.ttf`，均为原始文件，只改了文件名。`style.css` 用 `@font-face` 声明，同名声明优先于系统字体；渲染端等字体加载完再创建终端，最多等 3 秒。
- 许可要求：
  - Ubuntu Font Licence 1.0 允许捆绑和再分发，但每份副本都要附版权声明和许可全文，即 `ubuntu-font-licence.txt`。
  - MiSans 许可禁止单独分发字体，但允许分发用它制作的应用；前提是在软件中注明使用了 MiSans（标题栏 Tarmac 名称的悬停提示）、副本附带协议原文（`misans-license.pdf`），并且不得改编字体，所以不能裁剪字符集，只能整个放进去。
  - 构建时两份许可会随字体复制到 `dist/app/fonts/`。
- 更新字体时，要从官方来源替换原始文件，不要转换格式或裁剪；桌面冒烟测试的 `bundled-fonts` 检查四个字体都加载成功。

## 候选字体来源

选型时比较过以下字体：开源终端字体为更纱黑体、Maple Mono CN、霞鹜文楷等宽版，以 Ubuntu Sans Mono 为西文参照；厂商字体为阿里巴巴普惠体 3.0、鸿蒙黑体、Noto Sans CJK SC、MiSans，并附 Google Sans Code 西文样例。

| 字体 | 官方来源 |
| --- | --- |
| 更纱黑体 | [Sarasa Gothic](https://github.com/be5invis/Sarasa-Gothic) |
| Maple Mono CN | [Maple Mono](https://github.com/subframe7536/maple-font) |
| 霞鹜文楷等宽版 | [LXGW WenKai](https://github.com/lxgw/LxgwWenKai) |
| 阿里巴巴普惠体 | [阿里字体官网](https://www.alibabafonts.com/) |
| 鸿蒙黑体 | [华为设计资源](https://developer.huawei.com/consumer/cn/design/resource-V1/) |
| Noto Sans CJK | [Noto CJK](https://github.com/notofonts/noto-cjk) |
| Google Sans Code | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/googlesanscode) |
| MiSans | [小米字体官网](https://hyperos.mi.com/font/zh/) |

## 验证范围

Tarmac 内置字体（2026-11-19）：Linux 上把同一段中英文混排文字分别用包内字体和系统字体渲染，结果逐像素一致；Windows 和 macOS 上的实际效果尚未验证。
