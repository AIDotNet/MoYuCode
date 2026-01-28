/**
 * 文件路径解析工具
 * 用于从聊天消息中解析文件路径和行号
 */

/**
 * 解析后的文件引用信息
 */
export interface ParsedFileReference {
  /** 原始匹配的文本 */
  originalText: string
  /** 文件路径 */
  filePath: string
  /** 起始行号（可选） */
  startLine?: number
  /** 结束行号（可选） */
  endLine?: number
  /** 匹配在原文中的起始位置 */
  startIndex: number
  /** 匹配在原文中的结束位置 */
  endIndex: number
}

/**
 * 文件路径匹配模式
 * 支持多种常见格式：
 * - 相对路径: src/components/App.tsx
 * - 绝对路径: /home/user/project/src/App.tsx 或 C:\Users\project\src\App.tsx
 * - 带行号: src/App.tsx:10 或 src/App.tsx#L10
 * - 带行号范围: src/App.tsx:10-20 或 src/App.tsx#L10-L20
 * - Markdown 代码块引用: `src/App.tsx`
 */

// 文件扩展名白名单（常见代码文件）
const CODE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  // Backend
  'py', 'rb', 'php', 'java', 'kt', 'scala', 'go', 'rs', 'cs', 'fs', 'vb',
  // C/C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  // Config
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env',
  // Shell
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  // Docs
  'md', 'mdx', 'txt', 'rst',
  // Data
  'sql', 'graphql', 'gql',
  // Other
  'dockerfile', 'makefile', 'gitignore', 'editorconfig',
])

// 无扩展名但常见的文件名
const KNOWN_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile',
  'vagrantfile', 'brewfile', 'podfile', 'fastfile', 'appfile',
  '.gitignore', '.dockerignore', '.env', '.editorconfig',
  '.prettierrc', '.eslintrc', '.babelrc', '.npmrc',
  'package.json', 'tsconfig.json', 'webpack.config.js',
  'vite.config.ts', 'tailwind.config.js',
])

/**
 * 检查是否是有效的代码文件扩展名
 */
function isValidCodeExtension(ext: string): boolean {
  return CODE_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * 检查是否是已知的文件名
 */
function isKnownFilename(filename: string): boolean {
  return KNOWN_FILENAMES.has(filename.toLowerCase())
}

/**
 * 从文件路径中提取扩展名
 */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  
  if (lastDot > lastSlash && lastDot < filePath.length - 1) {
    return filePath.slice(lastDot + 1).toLowerCase()
  }
  return ''
}

/**
 * 从文件路径中提取文件名
 */
function getFilename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

/**
 * 验证文件路径是否看起来像有效的代码文件
 */
function isLikelyCodeFile(filePath: string): boolean {
  const ext = getExtension(filePath)
  const filename = getFilename(filePath)
  
  // 检查扩展名
  if (ext && isValidCodeExtension(ext)) {
    return true
  }
  
  // 检查已知文件名
  if (isKnownFilename(filename)) {
    return true
  }
  
  // 检查路径是否包含常见的代码目录
  const pathLower = filePath.toLowerCase()
  const codePathIndicators = [
    '/src/', '\\src\\',
    '/lib/', '\\lib\\',
    '/components/', '\\components\\',
    '/pages/', '\\pages\\',
    '/hooks/', '\\hooks\\',
    '/utils/', '\\utils\\',
    '/api/', '\\api\\',
    '/services/', '\\services\\',
    '/models/', '\\models\\',
    '/controllers/', '\\controllers\\',
    '/views/', '\\views\\',
    '/tests/', '\\tests\\',
    '/spec/', '\\spec\\',
  ]
  
  return codePathIndicators.some(indicator => pathLower.includes(indicator))
}
