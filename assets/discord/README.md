# Discord 活动素材

这些是涨跌方向示意图，不是账户真实 K 线。

| 上一交易日收益 | 大图 | 小图标 |
| --- | --- | --- |
| 大于 0 | portfolio_up.png | trend_up.png |
| 小于 0 | portfolio_down.png | trend_down.png |
| 等于 0 或数据缺失 | portfolio_flat.png | trend_flat.png |

在 Discord Developer Portal → 应用 → Rich Presence → 美术资产中上传六张 PNG，素材名称保留文件名（不含扩展名）。`preview.png` 仅用于本地预览，无需上传。

图片均为 1024×1024，可用安装了 Pillow 的 Python 运行 `scripts/generate-discord-assets.py` 重新生成。素材托管在 Discord，无需公开本机或账户服务。
