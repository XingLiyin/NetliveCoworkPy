import { describe, it, expect } from 'vitest'
import { getExt, fileType, CODE_LANGS } from './fileType'

describe('getExt', () => {
  it('lowercases and strips path', () => {
    expect(getExt('C:/x/Report.PDF')).toBe('pdf')
    expect(getExt('a/b/c.tar.gz')).toBe('gz')
  })
  it('uses the whole filename as key for extensionless files', () => {
    expect(getExt('project/Dockerfile')).toBe('dockerfile')
    expect(getExt('Makefile')).toBe('makefile')
    expect(getExt('.gitignore')).toBe('gitignore')
  })
})

describe('fileType', () => {
  it('classifies known types', () => {
    expect(fileType('png')).toBe('image')
    expect(fileType('md')).toBe('markdown')
    expect(fileType('docx')).toBe('docx')
    expect(fileType('xlsx')).toBe('excel')
    expect(fileType('csv')).toBe('excel')
    expect(fileType('py')).toBe('code')
    expect(fileType('cfg')).toBe('code')
    expect(fileType('sql')).toBe('code')
    expect(fileType('dockerfile')).toBe('code')
    expect(fileType('makefile')).toBe('code')
    expect(fileType('php')).toBe('code')
    expect(fileType('less')).toBe('code')
    expect(fileType('txt')).toBe('text')
    expect(fileType('env')).toBe('text')
    expect(fileType('gitignore')).toBe('text')
    expect(fileType('avif')).toBe('image')
    expect(fileType('pdf')).toBe('pdf')
    expect(fileType('pptx')).toBe('pptx')
    expect(fileType('bin')).toBe('binary')
  })
  it('maps code extensions to highlight.js language ids', () => {
    expect(CODE_LANGS['py']).toBe('python')
    expect(CODE_LANGS['rs']).toBe('rust')
  })
})

describe('drawio 精确路由', () => {
  it('.drawio / .dio（大小写不敏感）→ drawio 只读预览', () => {
    expect(fileType('drawio')).toBe('drawio')
    expect(fileType('dio')).toBe('drawio')
    expect(fileType(getExt('架构/Demo.DrawIO'))).toBe('drawio')   // 大小写路径
    expect(fileType(getExt('拓扑图.DIO'))).toBe('drawio')
  })
  it('普通 .xml 仍是代码预览，不被接管', () => {
    expect(fileType('xml')).toBe('code')
    expect(CODE_LANGS['xml']).toBe('xml')
  })
  it('其余扩展名照旧落 binary，不误入 drawio', () => {
    expect(fileType('bin')).toBe('binary')
    expect(fileType('')).toBe('binary')
  })
})
