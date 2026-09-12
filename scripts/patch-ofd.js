const fs = require('fs')
const path = require('path')

const targetFile = path.resolve(__dirname, '../node_modules/@miconvert/ofd-to-pdf/dist/index.js')
if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8')
  if (!content.includes('Array.isArray(relativePath)')) {
    content = content.replace(
      'function resolvePath(basePath, relativePath) {\n  if (relativePath.startsWith("/"))',
      'function resolvePath(basePath, relativePath) {\n  if (Array.isArray(relativePath)) relativePath = relativePath[0];\n  if (typeof relativePath === "object" && relativePath !== null) relativePath = relativePath["#text"] || String(relativePath);\n  if (typeof relativePath !== "string") return "";\n  if (relativePath.startsWith("/"))'
    )
    fs.writeFileSync(targetFile, content)
    console.log('Patched @miconvert/ofd-to-pdf successfully.')
  } else {
    console.log('Already patched.')
  }
}
