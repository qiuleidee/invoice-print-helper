# 电子发票（PDF）金额提取与批量统计 —— 技术实现文档

- 文档版本：v1.0
- 适用语言/运行环境：Node.js（建议 v18+）
- 适用发票类型：文本型 PDF 电子发票（增值税专票 / 普票 / 数电发票）

---

## 1. 背景与目标

### 1.1 背景

业务侧需要对批量导入的电子发票（PDF 格式）进行金额识别，并汇总统计。发票 PDF 分为**文本型**（可直接提取文字）和**扫描/图片型**（无文字层，需 OCR）两类，本方案聚焦覆盖率最高、成本最低的**文本型 PDF**，图片型作为异常兜底路径处理。

### 1.2 目标

1. 从 PDF 中稳定提取「价税合计」「金额（不含税）」「税额」「发票号码」等关键字段。
2. 对提取结果做**交叉校验**，避免把提取错误的金额静默计入统计总量。
3. 支持按发票号码去重，防止重复导入导致金额重复统计。
4. 对提取失败 / 校验不通过的文件生成**人工复核清单**，而非丢弃或强行采信。
5. 输出结构化统计结果（总金额、发票张数、明细、异常清单）。

### 1.3 非目标（本期不做）

- 图片型（扫描件）PDF 的 OCR 识别 —— 仅做类型判断和拦截，转入人工/后续 OCR 流程。
- 二维码识别、税局在线查验 —— 不在本方案范围内。
- OFD 格式解析。

---

## 2. 总体流程

```
批量PDF文件
    │
    ▼
① 类型判断（文本型 / 图片型）
    │
    ├── 图片型 ──────────────────────► 归入 needReview（待OCR/人工）
    │
    ▼ 文本型
② 提取原始文本
    │
    ▼
③ 文本清洗（去空格/换行归一化）
    │
    ▼
④ 关键字段提取
    ├─ 发票号码
    ├─ 价税合计（小写）        ← 主字段
    └─ 金额 + 税额（合计行）   ← 校验字段
    │
    ▼
⑤ 交叉校验（金额+税额 ≈ 价税合计，误差≤0.01）
    │
    ├── 校验失败 ────────────────────► 归入 needReview（待人工核对）
    │
    ▼ 校验通过
⑥ 按发票号码去重
    │
    ▼
⑦ 高精度累加（decimal.js）
    │
    ▼
⑧ 输出统计结果 + 异常清单
```

---

## 3. 技术选型

| 用途 | 库 | 说明 |
|---|---|---|
| PDF 文本提取 | `pdf-parse` | 纯 JS，无系统依赖，适合文本型 PDF |
| 高精度数值计算 | `decimal.js` | 避免浮点数误差在批量求和时累积 |
| （可选）日志 | `pino` 或 `console` | 记录提取失败原因，便于排查 |

```bash
npm install pdf-parse decimal.js
```

> 若后续要支持图片型 PDF，可在 `needReview` 流程后接入云 OCR（阿里云/腾讯云"增值税发票识别"API）或 `tesseract.js`，本文档暂不展开。

---

## 4. 目录结构

```
invoice-extractor/
├── package.json
├── src/
│   ├── index.js              # 入口：批量处理 + 汇总
│   ├── pdfReader.js          # PDF 读取与类型判断
│   ├── textCleaner.js        # 文本清洗
│   ├── fieldExtractor.js     # 关键字段提取（正则）
│   ├── validator.js          # 交叉校验逻辑
│   └── summarizer.js         # 去重 + 汇总统计
└── test/
    └── fixtures/              # 测试用样本PDF及对应期望结果
```

---

## 5. 核心模块设计

### 5.1 数据结构定义

每张发票解析后统一产出如下结构（后续所有模块围绕这个结构流转）：

```javascript
/**
 * @typedef {Object} InvoiceRecord
 * @property {string} filePath
 * @property {string|null} invoiceNo        - 发票号码
 * @property {number|null} totalAmount       - 价税合计（主字段，用于统计）
 * @property {number|null} amountNoTax       - 金额（不含税）
 * @property {number|null} taxAmount         - 税额
 * @property {'ok'|'extract_failed'|'validation_failed'|'image_pdf'} status
 * @property {string} [reviewReason]         - status非ok时的原因说明
 */
```

### 5.2 模块一：PDF 读取与类型判断（`pdfReader.js`）

```javascript
const pdf = require('pdf-parse');
const fs = require('fs');

/**
 * 判断PDF是否为文本型（可提取文字）
 * 经验阈值：清洗后纯文本长度 > 100 视为文本型，
 * 该阈值基于「一张正常发票哪怕排版错乱，字段拼起来也远超100字」的经验判断，
 * 实际接入时建议用真实样本再校准一次。
 */
async function readPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  const rawText = data.text || '';
  const strippedLength = rawText.replace(/\s/g, '').length;

  return {
    rawText,
    isTextPdf: strippedLength > 100,
  };
}

module.exports = { readPdfText };
```

### 5.3 模块二：文本清洗（`textCleaner.js`）

`pdf-parse` 按 PDF 内部文字对象顺序输出，不保证符合人眼阅读顺序，且常见数字被换行/空格截断。清洗只做保守处理（去多余空白），**不做"猜测性"的重排**，避免引入新的错误。

```javascript
function cleanText(rawText) {
  return rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** 供正则匹配用的"压平"版本：去掉所有空白字符 */
function flattenText(text) {
  return text.replace(/\s+/g, '');
}

module.exports = { cleanText, flattenText };
```

### 5.4 模块三：关键字段提取（`fieldExtractor.js`）

```javascript
/**
 * 提取「价税合计（小写）」——统计用的主金额字段
 * 优先匹配标准表述，逐条尝试，命中即返回
 */
function extractTotalAmount(flatText) {
  const patterns = [
    /价税合计[（(]小写[）)][：:]?[¥￥]?(\d+\.\d{2})/,
    /小写[）)][¥￥](\d+\.\d{2})/,
    /合计.{0,10}[¥￥](\d+\.\d{2})(?![\d])/,
  ];
  for (const p of patterns) {
    const m = flatText.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/**
 * 提取"合计"行的 金额(不含税) + 税额，用于交叉校验
 * 典型样式：合计 ¥1000.00 ¥130.00
 */
function extractAmountAndTax(flatText) {
  const m = flatText.match(/合计[¥￥](\d+\.\d{2})[¥￥](\d+\.\d{2})/);
  if (!m) return { amount: null, tax: null };
  return {
    amount: parseFloat(m[1]),
    tax: parseFloat(m[2]),
  };
}

/**
 * 提取发票号码
 * 数电发票号码为20位数字，纸质/传统电子发票为8位数字，做兼容匹配
 */
function extractInvoiceNo(flatText) {
  const m = flatText.match(/发票号码[：:]?(\d{8,20})/);
  return m ? m[1] : null;
}

module.exports = { extractTotalAmount, extractAmountAndTax, extractInvoiceNo };
```

> **可维护性建议**：正则规则集中在本模块，且每条规则独立、可单独增删。当遇到新版式发票匹配失败时，优先在这里"新增一条 pattern"，而不是修改已跑通的规则，防止影响存量场景。

### 5.5 模块四：交叉校验（`validator.js`）

```javascript
const Decimal = require('decimal.js');

const TOLERANCE = 0.01; // 允许的误差（元），覆盖四舍五入导致的尾差

/**
 * 校验规则：
 * - 若同时拿到 amount、tax、totalAmount 三者，要求 amount+tax ≈ totalAmount
 * - 若只拿到 totalAmount（没有合计行的拆分数据），视为"弱校验通过"，
 *   仍计入统计，但建议在结果中标记来源，便于后续抽查
 */
function crossCheck({ totalAmount, amountNoTax, taxAmount }) {
  if (totalAmount == null) {
    return { passed: false, reason: '未能提取到价税合计金额' };
  }
  if (amountNoTax == null || taxAmount == null) {
    return { passed: true, weak: true, reason: '缺少金额/税额拆分数据，仅弱校验通过' };
  }

  const sum = new Decimal(amountNoTax).plus(taxAmount);
  const diff = sum.minus(totalAmount).abs();

  if (diff.lte(TOLERANCE)) {
    return { passed: true, weak: false };
  }
  return {
    passed: false,
    reason: `金额校验不一致：金额(${amountNoTax})+税额(${taxAmount})=${sum.toFixed(2)}，与价税合计(${totalAmount})相差${diff.toFixed(2)}`,
  };
}

module.exports = { crossCheck };
```

### 5.6 模块五：单文件解析整合

```javascript
const { readPdfText } = require('./pdfReader');
const { cleanText, flattenText } = require('./textCleaner');
const { extractTotalAmount, extractAmountAndTax, extractInvoiceNo } = require('./fieldExtractor');
const { crossCheck } = require('./validator');

/**
 * 解析单张发票PDF，返回统一的 InvoiceRecord
 */
async function parseInvoicePdf(filePath) {
  const { rawText, isTextPdf } = await readPdfText(filePath);

  if (!isTextPdf) {
    return {
      filePath,
      invoiceNo: null,
      totalAmount: null,
      amountNoTax: null,
      taxAmount: null,
      status: 'image_pdf',
      reviewReason: '疑似图片型/扫描型PDF，无有效文字层，需走OCR或人工录入',
    };
  }

  const text = cleanText(rawText);
  const flat = flattenText(text);

  const invoiceNo = extractInvoiceNo(flat);
  const totalAmount = extractTotalAmount(flat);
  const { amount: amountNoTax, tax: taxAmount } = extractAmountAndTax(flat);

  if (!invoiceNo || totalAmount == null) {
    return {
      filePath,
      invoiceNo,
      totalAmount,
      amountNoTax,
      taxAmount,
      status: 'extract_failed',
      reviewReason: !invoiceNo ? '未提取到发票号码' : '未提取到价税合计金额',
    };
  }

  const checkResult = crossCheck({ totalAmount, amountNoTax, taxAmount });
  if (!checkResult.passed) {
    return {
      filePath,
      invoiceNo,
      totalAmount,
      amountNoTax,
      taxAmount,
      status: 'validation_failed',
      reviewReason: checkResult.reason,
    };
  }

  return {
    filePath,
    invoiceNo,
    totalAmount,
    amountNoTax,
    taxAmount,
    status: 'ok',
    ...(checkResult.weak ? { reviewReason: checkResult.reason } : {}),
  };
}

module.exports = { parseInvoicePdf };
```

### 5.7 模块六：批量去重与汇总（`summarizer.js`）

```javascript
const Decimal = require('decimal.js');

/**
 * @param {InvoiceRecord[]} records
 */
function summarize(records) {
  const seenInvoiceNo = new Set();
  let total = new Decimal(0);
  const okRecords = [];
  const duplicates = [];
  const needReview = [];

  for (const r of records) {
    if (r.status !== 'ok') {
      needReview.push(r);
      continue;
    }
    if (seenInvoiceNo.has(r.invoiceNo)) {
      duplicates.push(r);
      continue;
    }
    seenInvoiceNo.add(r.invoiceNo);
    total = total.plus(r.totalAmount);
    okRecords.push(r);
  }

  return {
    totalAmount: total.toFixed(2),
    invoiceCount: okRecords.length,
    duplicateCount: duplicates.length,
    reviewCount: needReview.length,
    records: okRecords,
    duplicates,
    needReview,
  };
}

module.exports = { summarize };
```

### 5.8 入口整合（`index.js`）

```javascript
const path = require('path');
const { parseInvoicePdf } = require('./invoiceParser'); // 5.6整合后的模块
const { summarize } = require('./summarizer');

/**
 * @param {string[]} filePaths - PDF 文件绝对路径列表
 */
async function batchProcess(filePaths) {
  const records = [];

  for (const filePath of filePaths) {
    try {
      const record = await parseInvoicePdf(filePath);
      records.push(record);
    } catch (err) {
      records.push({
        filePath,
        invoiceNo: null,
        totalAmount: null,
        amountNoTax: null,
        taxAmount: null,
        status: 'extract_failed',
        reviewReason: `解析异常：${err.message}`,
      });
    }
  }

  return summarize(records);
}

module.exports = { batchProcess };

// 使用示例
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: node index.js <发票PDF所在目录>');
    process.exit(1);
  }
  const fs = require('fs');
  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));

  batchProcess(files).then(result => {
    console.log('===== 统计结果 =====');
    console.log(`发票张数（有效）: ${result.invoiceCount}`);
    console.log(`金额合计: ¥${result.totalAmount}`);
    console.log(`重复发票数: ${result.duplicateCount}`);
    console.log(`待人工复核数: ${result.reviewCount}`);
    if (result.needReview.length) {
      console.log('----- 待复核清单 -----');
      result.needReview.forEach(r => {
        console.log(`${r.filePath} | ${r.status} | ${r.reviewReason}`);
      });
    }
  });
}
```

---

## 6. 测试方案

### 6.1 单元测试覆盖点

| 模块 | 用例 |
|---|---|
| `fieldExtractor` | 价税合计正则命中/不命中；多种表述变体；数字被空格截断的情况 |
| `validator` | 校验通过；误差在容差内通过；超出容差判定失败；缺失拆分字段时的弱校验 |
| `summarizer` | 正常汇总；重复发票号过滤；异常记录不计入总额 |

### 6.2 建议的测试样本集（`test/fixtures/`）

准备覆盖以下场景的真实（脱敏）样本 PDF，逐一验证提取结果与人工核对的期望值一致：

1. 标准增值税电子普通发票
2. 标准增值税专用发票
3. 数电发票（全面数字化电子发票，无发票代码）
4. 文字提取顺序错乱的版式（表格密集）
5. 扫描件（预期被判定为 `image_pdf`）
6. 人为构造的"金额与税额对不上"的异常样本（验证校验逻辑生效）
7. 同一发票号重复出现两次的场景（验证去重）

### 6.3 验收标准（建议）

- 文本型 PDF 提取成功率 ≥ 95%（以标准版式为主的样本集）。
- 交叉校验误报率（正确金额被误判为校验失败）应为 0，即校验规则的容差和正则要按真实样本反复调优，宁可漏判为"弱校验通过"也不能造成误伤。
- 所有 `status !== 'ok'` 的记录必须完整体现在 `needReview` 中，绝不能被静默丢弃。

---

## 7. 已知局限与后续演进方向

1. **正则强依赖版式**：不同税控服务商（百旺、航信等）生成的 PDF 排版有细微差异，正则规则需要持续积累真实样本迭代，建议将 `fieldExtractor.js` 中的 patterns 设计成可配置化，甚至后续迁移到规则配置文件，而非写死在代码里。
2. **不覆盖图片型 PDF**：当前仅做类型识别拦截，图片型统一转入 `needReview`。后续如果此类占比较高，需要单独评审接入云 OCR（阿里云/腾讯云"增值税发票识别"专用接口，非通用文字识别）的方案，包括成本、并发限流、失败重试策略。
3. **"弱校验通过"的记录建议抽样复核**：即只提取到价税合计、没有拆分出金额+税额的发票，虽然计入了统计总额，但建议定期抽样，确认这类版式没有被规则误判。
4. **金额上限异常校验**：可在 `validator.js` 中追加"单张发票金额超过阈值时强制转人工复核"的业务规则，作为财务合规的额外防线（本文档暂未包含，按实际业务需要再加）。

---

## 8. 附：package.json 参考

```json
{
  "name": "invoice-extractor",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "pdf-parse": "^1.1.1",
    "decimal.js": "^10.4.3"
  }
}
```
