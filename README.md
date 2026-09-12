# 发票打印助手 (Invoice Print Helper)

发票打印助手是一款基于 Electron 构建的跨平台桌面客户端，旨在为用户提供极其便捷、高效的电子发票批量处理与打印体验。

## 🌟 主要功能

- **多格式支持**：支持拖拽导入 PDF、JPG、PNG 等主流发票格式，甚至支持解析 ZIP 压缩包中的发票文件。
- **所见即所得的页面调整**：提供强大的前端交互界面，您可以在界面上直观地缩放、拖拽调整每张发票的实际打印位置。
- **智能合并与导出**：将多张零散的发票智能合并到一页 PDF 或生成单页 PDF，方便使用 A4 纸集中打印，极大节省纸张与时间。
- **纯本地处理**：所有文件解析、裁剪、合并与光栅化操作均在本地机器上运行，绝对保证财务数据与发票信息隐私安全。

## 🚀 快速开始

### 依赖安装

请确保您的设备上已经安装了 [Node.js](https://nodejs.org/)。

```bash
# 克隆仓库
git clone https://github.com/qiuleidee/invoice-print-helper.git
cd invoice-print-helper

# 安装项目依赖
npm install
```

### 开发环境运行

```bash
# 启动 Electron 开发调试环境
npm start
```

### 生产环境打包

```bash
# 编译并生成 Windows NSIS 安装包 (.exe)
npm run build
```

打包成功后，安装程序将会输出在 `dist/` 目录下。

## 🛠️ 技术栈

- **Electron & Node.js**：提供跨平台桌面能力与底层文件系统访问。
- **Vanilla JS + HTML5**：原生、轻量级的前端交互框架，极致性能体验。
- **PDF-Lib & PDF.js**：专业处理、合成以及渲染 PDF 文件的高级类库。

## 📄 许可证

本项目遵循 [MIT License](LICENSE) 开源协议。
