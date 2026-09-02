# Bed-board PDF fallback fonts

These static TrueType fonts are bundled only for offline bed-board PDF rendering.
They are not fetched at runtime. Latin text continues to use the `pdf` package's
built-in Helvetica fonts; these Noto Sans faces are fallback fonts for the four
Indian scripts supported by the Staff application.

All four families are licensed under the SIL Open Font License 1.1. The exact
upstream `OFL.txt`, `AUTHORS.txt`, and `CONTRIBUTORS.txt` notices from each
release are retained under `licenses/`; trailing whitespace is normalized.

| Family | Official repository | Immutable release tag | Tag commit | Release ZIP SHA-256 |
| --- | --- | --- | --- | --- |
| Noto Sans Devanagari | `https://github.com/notofonts/devanagari` | `NotoSansDevanagari-v2.006` | `bb8d2566a1708ef2dcc6396ee2eb261a18967f76` | `4c582c103f0a42836338df07148b23a0aa080cce8393ddc4364af87eb22ebd85` |
| Noto Sans Tamil | `https://github.com/notofonts/tamil` | `NotoSansTamil-v2.004` | `f34a08d1ae3fa810581f63410296d971bdcd62dc` | `f8284e0f200a7f29a439b4ec88280d864b2b31f8479111c5b658ba6da38b3005` |
| Noto Sans Telugu | `https://github.com/notofonts/telugu` | `NotoSansTelugu-v2.005` | `e97c3409a8347d68cccd06a82a68b418c315ee0c` | `3553e00ca341dc06f4a143c604dd93a1342553169b5a06dc8b0ff50ab6eba0a2` |
| Noto Sans Malayalam | `https://github.com/notofonts/malayalam` | `NotoSansMalayalam-v2.104` | `0fd65e553a6af3dc1c09ed39dfe8933e01c17b32` | `2ebd31e79f2893025d659def7784e0ec3557e7ff9ac105adcc82d35782913bf2` |

The vendored files are the `full/ttf` Regular and Bold static faces. Their SFNT
table directories contain no `fvar` table.

| Vendored file | SHA-256 |
| --- | --- |
| `NotoSansDevanagari-Regular.ttf` | `c82fb837eed9988ee6a240ce0635fe18f9c5859389206a24dfc348c926f42500` |
| `NotoSansDevanagari-Bold.ttf` | `1ebda0d88076fef54dd70b4dc48deb4dadf634cc9c7c325b812facb802ae3c51` |
| `NotoSansTamil-Regular.ttf` | `0afbc221964b6048c6d771c525be474d21b288a621dce0fafedd695cc5c98e4e` |
| `NotoSansTamil-Bold.ttf` | `39bbf8317e5c899ae381d467e651ea49a1e3d5189d16075f24c3c593a365ac7a` |
| `NotoSansTelugu-Regular.ttf` | `e0595bcf47b907b2afb77a34ae64c3e8351f56452c66983660172c6b9ea15576` |
| `NotoSansTelugu-Bold.ttf` | `2c8c1f224f289a9d2660e4eeef1f5d17cfd8c4780dbbf225a8556dd409c4d34b` |
| `NotoSansMalayalam-Regular.ttf` | `d18b5c10d85bba3d3d89775484bcfa731112f501ac070793ddbda5a36992520f` |
| `NotoSansMalayalam-Bold.ttf` | `a6832b5b45e271240967cb7c941f37788486710e25973f7400d26ec14ad33d2e` |
