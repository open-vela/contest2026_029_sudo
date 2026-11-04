# 构建 / 部署 / 调试命令集

均为本次会话在 Windows (Git Bash) 实测可用的命令，变量：`ADB="$HOME/.vela/sdk/tools/adb/win/adb.exe"`。

## 构建

```bash
cd <project> && npm run build            # aiot build；产物自动到 dist/
# EPERM 报错（目录瞬时锁）→ 直接重试一次
# 版本纪律：manifest.json versionName/versionCode 每次构建递增
```

验证 rpk 内容（资源是否打入）：

```bash
python -c "import zipfile; ns=zipfile.ZipFile('dist/app.rpk').namelist(); print(len(ns)); print([n for n in ns if n.endswith('.png')][:20])"
```

⚠️ **构建后必检 minAPILevel**（小米手环 9 部分固件装带此字段的包会崩机重启，字段是构建工具注入的、源 manifest 里没有）：

```bash
python -c "import zipfile,json; z=zipfile.ZipFile('dist/app.rpk'); print(json.loads(z.read('manifest.json')).get('minAPILevel'))"
# 若非 None，解包删字段重打（仅 debug 自装包，重打包破坏签名）：
python - <<'EOF'
import zipfile, shutil, json, os
src='dist/app.rpk'; dst='dist/app.nominapi.rpk'; pkg='manifest.json'
zin=zipfile.ZipFile(src); zout=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    data=zin.read(it.filename)
    if it.filename==pkg:
        m=json.loads(data); m.pop('minAPILevel',None); data=json.dumps(m).encode()
    zout.writestr(it, data)
zout.close()
EOF
```

## 模拟器部署（adb 直连，绕过 MCP 超时）

```bash
ADB="$HOME/.vela/sdk/tools/adb/win/adb.exe"
"$ADB" devices                                       # emulator-5554 为 NuttX adb_board
MSYS_NO_PATHCONV=1 timeout 60 "$ADB" -s emulator-5554 push "E:/path/app.rpk" /data/app.rpk
MSYS_NO_PATHCONV=1 timeout 45 "$ADB" -s emulator-5554 shell "pm uninstall vela.PkgName"   # 规避 -19
MSYS_NO_PATHCONV=1 timeout 90 "$ADB" -s emulator-5554 shell "pm install /data/app.rpk"
MSYS_NO_PATHCONV=1 timeout 60 "$ADB" -s emulator-5554 shell "am start vela.PkgName"       # 可能不切前台
```

要点：
- nsh shell 响应慢 —— 长 timeout + 输出落盘再 grep（`> /tmp/o.txt 2>&1` 后读文件，直接管道 grep 会因提前退出丢结果）。
- 验证设备上装的版本：`pm list packages` 中查包 → 或读 `/data/app/<pkg>/manifest.json`。
- nsh 无 screencap；**应用级日志/崩溃以人工目视与宿主机截图为凭**。
- **每轮测试完彻底杀模拟器进程再冷启**（不杀会僵死：日志停更、adb 挂起、界面冻结）。

## openvela 官方模拟器（Vel-pro AVD）

与 aiot 内置模拟器（emulator-5554 直连）是**两套东西**；openvela 模拟器更接近真实环境：

```bash
# 冷启动（grpc 8555；-show-kernel 日志更全）
<SDK 根>/.vela/sdk/emulator/windows-x86_64/emulator.exe -vela -avd Vel-pro -grpc 8555 -show-kernel
# adbd 走 tcp 5555，多实例时 adb devices 不显示，需手动连：
adb connect 127.0.0.1:5555
```

- **gRPC 截图**（稳定，优于 PrintWindow）：proto 在 `node_modules/@aiot-toolkit/emulator/lib/static/proto/emulator_controller.proto`，`getScreenshot{format:'PNG'}` 走 `127.0.0.1:8555`。
- gRPC `sendTouch/sendKey` 输入注入在部分实例罢工（发送成功但输入层不响应）——输入验证换实例或人工手动点击。
- 应用 `console.log` 进宿主日志；按应用自定义前缀 grep（如 `[DS]`、`[KB]`）。
- 多模拟器并存会抢 gRPC 端口（8554 被 Android x86 模拟器占用）与 adb，尽量单实例。
- 自写 MCP（`vela-mcp/index.js`，stdio JSON-RPC 零依赖）：`emulator_start`（全杀→清锁→冷启→等 adb→connect）/ `emulator_deploy`（push+install+杀旧+am start）/ `emulator_logs`（按关键字读日志）/ `emulator_exec` / `build`，可照抄搭同款。

## 宿主机截图（模拟器窗口）

```powershell
# 保存路径不能带空格：先存 C:\Temp\ 再 cp
$proc = Get-Process qemu-system-armel | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
# PrintWindow 免前台截图（GetWindowRect -> System.Drawing.Bitmap -> PrintWindow(handle, hdc, 2) -> Save）
# 窗口最小化(NO_WINDOW/尺寸 160x28 异常)时先 ShowWindow(handle, 9) 再截
```

## 真手环（小米手环 9/10，蓝牙）

通道：BLE 认证（配对窗 30 秒内手环点「配对」）→ SPP(RFCOMM ch5) 上传 rpk。

```bash
# 独立脚本模式（无超时限制；bleak 装在 Python312）
cd <工程根>/ble_tools
python install_wsg_v66.py
```

脚本内关键常量（`install_rpk56.py` 派生）：

```python
MAC_STR = "04:34:C3:13:43:42"     # 手环蓝牙 MAC
RPK_PATH = r"...\dist\app.rpk"    # 待装包
PKG_NAME = "vela.WanShiGe"        # manifest package 字段
# v56 混合模式：BLE 认证+命令 → 并行 SPP 接管上传（BLE 窗口只够认证，大包必须 SPP）
```

前置条件（缺一必失败）：
- 手环**不在**与手机运动健康 App 的连接中（否则不广播，报 `device not reachable`）。
- 手环电量充足、贴近电脑（RFCOMM 距离敏感）。
- **装包前先装一个已知好包确认手环安装功能健康**——手环安装功能会进入「装什么都失败」的病态（重启手环自愈），病态期的实验结论全部作废。
- 手环 9 部分固件装带 `minAPILevel` 的包会崩机重启（构建节有检查/删除脚本）。

MCP 工具（若环境配置了 xiaomi-band9）：`band_ping` → `band_install_app(rpk_path, package_name)` → `band_list_apps` 验证；大包优先用独立脚本。

## 启动校验与激活

- 激活码体系：设备码 4 位（storage `device_code`）→ 密钥（服务端用 `tools/genKey.py` 按同算法生成）。
- splash 校验加 watchdog 兜底（storage 回调 3 秒未返回强制放行），**但预热/长任务分支必须先 clearTimeout 该 watchdog**。
- 缓存预热（学 velaPro）：逐片建 storage 缓存、每步让出一帧（`await new Promise(r=>setTimeout(r,0))`）、单步 20s 超时、写数据版本标记（`totalCount_endId`）——数据升级自动失效重预热。

## 常用自检脚本（项目 tools/ 下）

| 脚本 | 用途 |
|---|---|
| `testPoemSearch.js` | mock 环境引擎闭环（init/搜索/详情/分页/去重）|
| `test_filter.js` | 引擎筛选断言（单维/双维/翻页无重叠）|
| `test_e2e_filter.js` | UI 包装层 → 引擎 全链参数验证 |
| `buildPoemIndex.js` | 数据 → 索引构建（含结构断言）|
| `genKey.py` | 激活密钥生成 |
| `genArrowIcons.js` / `genHeartIcons.js` | PNG 图标生成（线段栅格化 / 隐式方程+差集描边）|
