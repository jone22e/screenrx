import { describe, expect, it } from 'vitest'
import { granteeOf } from './grantee'

const devElectron = '/Users/dev/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
const packaged = '/Applications/ScreenRx.app/Contents/MacOS/ScreenRx'

describe('granteeOf', () => {
  it('names the app whose embedded terminal launched a development build', () => {
    expect(granteeOf('/Applications/Claude.app/Contents/MacOS/Claude', devElectron)).toEqual({
      name: 'Claude',
      isLauncher: true
    })
  })

  it('uses the outermost bundle of a nested helper app', () => {
    const helper =
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper'
    expect(granteeOf(helper, devElectron).name).toBe('Visual Studio Code')
  })

  it('falls back to the executable name for command-line launchers', () => {
    expect(granteeOf('/Users/dev/.local/bin/claude', devElectron)).toEqual({
      name: 'claude',
      isLauncher: true
    })
  })

  it('recognises the packaged app as its own grantee', () => {
    expect(granteeOf(packaged, packaged)).toEqual({ name: 'ScreenRx', isLauncher: false })
  })

  it('reports an unknown grantee when the system gives no answer', () => {
    expect(granteeOf(undefined, devElectron)).toEqual({ name: null, isLauncher: false })
  })
})
