// Theme presets and the token system. A theme only has to name its core
// colors; everything else (hover, selection, drawer tones, terminal palette)
// is derived so custom themes stay consistent with the presets.

export type ThemeKind = 'dark' | 'light'

export interface ThemeColors {
  editor: string; panel: string; line: string; ink: string; muted: string; accent: string
  green: string; amber: string; red: string
  keyword: string; string: string; number: string; type: string; function: string; comment: string
  rail?: string; bar?: string; drawer?: string; hover?: string; selection?: string; secondary?: string; icon?: string
  accentFill?: string; accentBorder?: string; currentLine?: string
  variable?: string; property?: string; operator?: string; tag?: string; attribute?: string; shadow?: string
  textSelection?: string; occurrence?: string; occurrenceBorder?: string; indentGuide?: string
}

export interface TerminalColors {
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string; brightBlue?: string; brightMagenta?: string; brightCyan?: string; brightWhite?: string
}

export interface Theme {
  id: string
  name: string
  kind: ThemeKind
  colors: ThemeColors
  terminal?: Partial<TerminalColors>
  italicComments?: boolean
  custom?: boolean
  basedOn?: string
}

function rgb(hex: string): [number, number, number, number] {
  let value = hex.trim().replace('#', '')
  if (value.length === 3 || value.length === 4) value = value.split('').map(char => char + char).join('')
  const number = (start: number) => parseInt(value.slice(start, start + 2), 16)
  return [number(0), number(2), number(4), value.length >= 8 ? number(6) / 255 : 1]
}

export function isHex(value: string) { return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim()) }

/** Blend `from` toward `to` by `amount` (0–1). */
export function mix(from: string, to: string, amount: number) {
  const a = rgb(from), b = rgb(to)
  const channel = (index: number) => Math.round(a[index] + (b[index] - a[index]) * amount).toString(16).padStart(2, '0')
  return '#' + channel(0) + channel(1) + channel(2)
}

export function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map(value => value / 255)
  const linear = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export type ResolvedColors = Required<ThemeColors>

export function resolve(theme: Theme): { colors: ResolvedColors; terminal: Required<TerminalColors> } {
  const c = theme.colors
  const dark = theme.kind === 'dark'
  // Themes whose accent is just the text colour get a soft blue for text selection.
  const tint = c.accent.toLowerCase() === c.ink.toLowerCase() || luminance(c.accent) < .02 || luminance(c.accent) > .9 ? (dark ? '#5b8def' : '#3d6fd9') : c.accent
  const colors: ResolvedColors = {
    ...c,
    rail: c.rail ?? mix(c.editor, c.panel, .55),
    bar: c.bar ?? mix(c.editor, c.panel, .8),
    drawer: c.drawer ?? mix(c.editor, c.panel, .4),
    hover: c.hover ?? mix(c.panel, c.ink, dark ? .07 : .06),
    selection: c.selection ?? mix(c.panel, c.accent, dark ? .2 : .13),
    secondary: c.secondary ?? mix(c.ink, c.muted, .45),
    icon: c.icon ?? c.muted,
    accentFill: c.accentFill ?? mix(c.editor, c.accent, dark ? .2 : .12),
    accentBorder: c.accentBorder ?? mix(c.editor, c.accent, dark ? .38 : .3),
    currentLine: c.currentLine ?? mix(c.editor, c.ink, dark ? .035 : .03),
    variable: c.variable ?? c.ink,
    property: c.property ?? c.variable ?? c.ink,
    operator: c.operator ?? mix(c.ink, c.muted, .45),
    tag: c.tag ?? c.keyword,
    attribute: c.attribute ?? c.type,
    shadow: c.shadow ?? (dark ? '#00000088' : '#32384633'),
    textSelection: c.textSelection ?? mix(c.editor, tint, dark ? .36 : .22),
    occurrence: c.occurrence ?? mix(c.editor, tint, dark ? .17 : .1),
    occurrenceBorder: c.occurrenceBorder ?? mix(c.editor, tint, dark ? .45 : .38),
    indentGuide: c.indentGuide ?? mix(c.editor, c.ink, dark ? .11 : .09),
  }
  const t = theme.terminal ?? {}
  const base: TerminalColors = {
    black: t.black ?? (dark ? mix(c.editor, c.ink, .18) : mix(c.ink, c.editor, .1)),
    red: t.red ?? c.red, green: t.green ?? c.green, yellow: t.yellow ?? c.amber,
    blue: t.blue ?? c.function, magenta: t.magenta ?? c.keyword, cyan: t.cyan ?? (c.operator ?? c.string),
    white: t.white ?? (dark ? c.ink : mix(c.editor, c.muted, .5)),
  }
  const bright = (value: string) => dark ? mix(value, '#ffffff', .18) : mix(value, '#000000', .12)
  return {
    colors,
    terminal: {
      ...base,
      brightBlack: t.brightBlack ?? c.muted,
      brightRed: t.brightRed ?? bright(base.red), brightGreen: t.brightGreen ?? bright(base.green),
      brightYellow: t.brightYellow ?? bright(base.yellow), brightBlue: t.brightBlue ?? bright(base.blue),
      brightMagenta: t.brightMagenta ?? bright(base.magenta), brightCyan: t.brightCyan ?? bright(base.cyan),
      brightWhite: t.brightWhite ?? (dark ? '#ffffff' : c.ink),
    },
  }
}

const kebab = (key: string) => key.replace(/[A-Z]/g, char => '-' + char.toLowerCase())

/** The colours that make up a syntax theme; everything else belongs to the editor theme. */
export const syntaxKeys = ['keyword', 'string', 'number', 'type', 'function', 'comment', 'variable', 'property', 'operator', 'tag', 'attribute'] as const

/** Paints only the code colours from another theme (Settings → Appearance → Syntax colours). */
export function applySyntax(theme: Theme) {
  const { colors } = resolve(theme)
  const root = document.documentElement
  for (const key of syntaxKeys) root.style.setProperty('--' + kebab(key), colors[key])
  root.style.setProperty('--comment-style', theme.italicComments === false ? 'normal' : 'italic')
}

export function applyTheme(theme: Theme) {
  const { colors } = resolve(theme)
  const root = document.documentElement
  for (const [key, value] of Object.entries(colors)) root.style.setProperty('--' + kebab(key), value)
  root.style.setProperty('--comment-style', theme.italicComments === false ? 'normal' : 'italic')
  root.dataset.theme = theme.kind
  root.style.colorScheme = theme.kind
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.bar)
}

export const presets: Theme[] = [
  {
    id: 'still-dark', name: 'Still Dark', kind: 'dark',
    colors: {
      editor: '#1c1d20', panel: '#1c1d20', rail: '#1c1d20', bar: '#1c1d20', drawer: '#1c1d20', line: '#2f3034', hover: '#25262a',
      selection: '#33353b', ink: '#d2d2d6', secondary: '#a9a9b0', muted: '#86868e', icon: '#86868e', accent: '#d2d2d6',
      accentFill: '#2a2b30', accentBorder: '#43444b', green: '#93bd93', amber: '#d0a352', red: '#dc8d8d', currentLine: '#222327',
      keyword: '#c49ec4', string: '#b2c08f', number: '#d9a873', type: '#d0bc95', function: '#9dbdb1', comment: '#7e7f88',
      operator: '#a0a0a8', property: '#a7b7cb', variable: '#cfcfd4',
    },
    terminal: { black: '#3a3a40', blue: '#9fb3c8', magenta: '#c9a0c9', cyan: '#9fc1b4' },
  },
  {
    id: 'still-light', name: 'Still Light', kind: 'light',
    colors: {
      editor: '#ffffff', panel: '#ffffff', rail: '#ffffff', bar: '#ffffff', drawer: '#ffffff', line: '#e8e8eb', hover: '#f4f4f5',
      selection: '#ebebee', ink: '#18181b', secondary: '#45454c', muted: '#666670', icon: '#666670', accent: '#18181b',
      accentFill: '#f1f1f3', accentBorder: '#d4d4d8', green: '#3f7d4f', amber: '#a16207', red: '#b03a3a', currentLine: '#f7f7f8',
      keyword: '#7a4a7f', string: '#556b2f', number: '#9a5a1a', type: '#7d5f28', function: '#2f6a5e', comment: '#80808a',
      operator: '#55555c', property: '#3f5a7d', variable: '#202024',
    },
    terminal: { black: '#18181b', white: '#a1a1aa', blue: '#3d5f86', magenta: '#7a4a7f', cyan: '#2f6a5e' },
  },
  {
    id: 'paper-yellow', name: 'Paper Yellow', kind: 'light',
    colors: {
      textSelection: '#efd98a', occurrence: '#f3e4a6', occurrenceBorder: '#cdb45a',
      editor: '#fbf5dc', panel: '#fbf5dc', rail: '#fbf5dc', bar: '#fbf5dc', drawer: '#fbf5dc', line: '#e8dcb2', hover: '#f4ebc8',
      selection: '#efe2b4', ink: '#2a2516', secondary: '#4e4630', muted: '#7a6f52', icon: '#7a6f52', accent: '#2a2516',
      accentFill: '#f3e8c2', accentBorder: '#dccb94', green: '#4b6b2f', amber: '#9a5b0f', red: '#a33a2a', currentLine: '#f6eecd',
      keyword: '#7b3f5e', string: '#5a6b22', number: '#a0521b', type: '#77591d', function: '#2f5f57', comment: '#9a8d68',
      operator: '#5d553e', property: '#3e5878', variable: '#2a2516',
    },
    terminal: { black: '#2a2516', white: '#9a8d68', blue: '#3e5878', magenta: '#7b3f5e', cyan: '#2f5f57' },
  },
  {
    id: 'one-dark', name: 'One Dark', kind: 'dark',
    colors: {
      editor: '#282c34', panel: '#21252b', bar: '#21252b', rail: '#21252b', drawer: '#21252b', line: '#181a1f', ink: '#abb2bf',
      muted: '#7f848e', accent: '#568af2', selection: '#2c313a', hover: '#2c313c', currentLine: '#2c313c',
      green: '#98c379', amber: '#e5c07b', red: '#e06c75',
      keyword: '#c678dd', string: '#98c379', number: '#d19a66', type: '#e5c07b', function: '#61afef', comment: '#5c6370',
      variable: '#e06c75', property: '#e06c75', operator: '#56b6c2', tag: '#e06c75', attribute: '#d19a66',
    },
    terminal: { black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0' },
  },
  {
    id: 'one-light', name: 'One Light', kind: 'light',
    colors: {
      editor: '#fafafa', panel: '#eaeaeb', bar: '#eaeaeb', rail: '#eaeaeb', drawer: '#f2f2f2', line: '#dbdbdc', ink: '#383a42',
      muted: '#696c77', accent: '#526fff', selection: '#dbdbdc', currentLine: '#f0f0f1',
      green: '#50a14f', amber: '#c18401', red: '#e45649',
      keyword: '#a626a4', string: '#50a14f', number: '#986801', type: '#c18401', function: '#4078f2', comment: '#a0a1a7',
      variable: '#e45649', property: '#e45649', operator: '#0184bc', tag: '#e45649', attribute: '#986801',
    },
    terminal: { black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7' },
  },
  {
    id: 'github-dark', name: 'GitHub Dark', kind: 'dark',
    colors: {
      editor: '#0d1117', panel: '#010409', bar: '#010409', rail: '#010409', drawer: '#0d1117', line: '#30363d', ink: '#e6edf3',
      muted: '#7d8590', accent: '#2f81f7', hover: '#161b22', selection: '#1c2a3e', currentLine: '#161b22',
      green: '#3fb950', amber: '#d29922', red: '#f85149',
      keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', type: '#ffa657', function: '#d2a8ff', comment: '#8b949e',
      variable: '#ffa657', property: '#79c0ff', operator: '#ff7b72', tag: '#7ee787', attribute: '#79c0ff',
    },
    italicComments: false,
    terminal: { black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4' },
  },
  {
    id: 'github-light', name: 'GitHub Light', kind: 'light',
    colors: {
      editor: '#ffffff', panel: '#f6f8fa', bar: '#f6f8fa', rail: '#f6f8fa', drawer: '#ffffff', line: '#d0d7de', ink: '#1f2328',
      muted: '#656d76', accent: '#0969da', hover: '#eaeef2', selection: '#ddf4ff', currentLine: '#f6f8fa',
      green: '#1a7f37', amber: '#9a6700', red: '#d1242f',
      keyword: '#cf222e', string: '#0a3069', number: '#0550ae', type: '#953800', function: '#8250df', comment: '#6e7781',
      variable: '#953800', property: '#0550ae', operator: '#cf222e', tag: '#116329', attribute: '#0550ae',
    },
    italicComments: false,
    terminal: { black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781' },
  },
  {
    id: 'darcula', name: 'Darcula', kind: 'dark',
    colors: {
      editor: '#2b2b2b', panel: '#3c3f41', bar: '#3c3f41', rail: '#3c3f41', drawer: '#2b2b2b', line: '#323232', ink: '#a9b7c6',
      muted: '#808080', accent: '#4a88c7', selection: '#214283', hover: '#4b4f52', currentLine: '#323232',
      green: '#6a8759', amber: '#bbb529', red: '#bc3f3c',
      keyword: '#cc7832', string: '#6a8759', number: '#6897bb', type: '#a9b7c6', function: '#ffc66d', comment: '#808080',
      variable: '#9876aa', property: '#9876aa', operator: '#a9b7c6', tag: '#e8bf6a', attribute: '#bababa',
    },
    terminal: { black: '#000000', red: '#ff6b68', green: '#a8c023', yellow: '#d6bf55', blue: '#5394ec', magenta: '#ae8abe', cyan: '#299999', white: '#ffffff' },
  },
  {
    id: 'jetbrains-dark', name: 'JetBrains Dark', kind: 'dark',
    colors: {
      editor: '#1e1f22', panel: '#2b2d30', bar: '#2b2d30', rail: '#2b2d30', drawer: '#1e1f22', line: '#393b40', ink: '#bcbec4',
      muted: '#6f737a', accent: '#3574f0', selection: '#2e436e', hover: '#393b40', currentLine: '#26282e',
      green: '#5fb865', amber: '#d6ae58', red: '#f75464',
      keyword: '#cf8e6d', string: '#6aab73', number: '#2aacb8', type: '#bcbec4', function: '#56a8f5', comment: '#7a7e85',
      variable: '#c77dbb', property: '#c77dbb', operator: '#bcbec4', tag: '#d5b778', attribute: '#bababa',
    },
    terminal: { black: '#1e1f22', red: '#f0524f', green: '#5c962c', yellow: '#a68a0d', blue: '#3993d4', magenta: '#a771bf', cyan: '#00a3a3', white: '#808080' },
  },
  {
    id: 'intellij-light', name: 'IntelliJ Light', kind: 'light',
    colors: {
      editor: '#ffffff', panel: '#f7f8fa', bar: '#f7f8fa', rail: '#f7f8fa', drawer: '#ffffff', line: '#ebecf0', ink: '#080808',
      muted: '#818594', accent: '#3574f0', selection: '#d5e1ff', hover: '#dfe1e5', currentLine: '#f5f8fe',
      green: '#067d17', amber: '#9e880d', red: '#f50000',
      keyword: '#0033b3', string: '#067d17', number: '#1750eb', type: '#000000', function: '#00627a', comment: '#8c8c8c',
      variable: '#871094', property: '#871094', operator: '#080808', tag: '#0033b3', attribute: '#174ad4',
    },
    terminal: { black: '#000000', red: '#d52753', green: '#23974a', yellow: '#df631c', blue: '#275fe4', magenta: '#823ff1', cyan: '#27618d', white: '#818594' },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', kind: 'dark',
    colors: {
      editor: '#002b36', panel: '#073642', bar: '#00212b', rail: '#00212b', drawer: '#002b36', line: '#0e4452', ink: '#93a1a1',
      muted: '#657b83', accent: '#268bd2', selection: '#0a4555', currentLine: '#073642',
      green: '#859900', amber: '#b58900', red: '#dc322f',
      keyword: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', function: '#268bd2', comment: '#586e75',
      variable: '#cb4b16', operator: '#93a1a1',
    },
    terminal: { black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5' },
  },
  {
    id: 'solarized-light', name: 'Solarized Light', kind: 'light',
    colors: {
      editor: '#fdf6e3', panel: '#eee8d5', bar: '#eee8d5', rail: '#eee8d5', drawer: '#fdf6e3', line: '#ddd6c1', ink: '#586e75',
      muted: '#839496', accent: '#268bd2', selection: '#e6dfc8', currentLine: '#f5efdc',
      green: '#859900', amber: '#b58900', red: '#dc322f',
      keyword: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', function: '#268bd2', comment: '#93a1a1',
      variable: '#cb4b16', operator: '#657b83',
    },
    terminal: { black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1' },
  },
  {
    id: 'nord', name: 'Nord', kind: 'dark',
    colors: {
      editor: '#2e3440', panel: '#2b303b', bar: '#2b303b', rail: '#2b303b', drawer: '#2e3440', line: '#3b4252', ink: '#d8dee9',
      muted: '#7b88a1', accent: '#88c0d0', selection: '#3b4252', hover: '#3b4252', currentLine: '#3b4252',
      green: '#a3be8c', amber: '#ebcb8b', red: '#bf616a',
      keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', type: '#8fbcbb', function: '#88c0d0', comment: '#616e88',
      variable: '#d8dee9', operator: '#81a1c1',
    },
    terminal: { black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0' },
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', kind: 'dark',
    colors: {
      editor: '#282828', panel: '#1d2021', bar: '#1d2021', rail: '#1d2021', drawer: '#282828', line: '#3c3836', ink: '#ebdbb2',
      muted: '#928374', accent: '#83a598', selection: '#3c3836', hover: '#32302f', currentLine: '#32302f',
      green: '#b8bb26', amber: '#fabd2f', red: '#fb4934',
      keyword: '#fb4934', string: '#b8bb26', number: '#d3869b', type: '#fabd2f', function: '#8ec07c', comment: '#928374',
      variable: '#83a598', operator: '#fe8019',
    },
    terminal: { black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984' },
  },
  {
    id: 'monokai', name: 'Monokai', kind: 'dark',
    colors: {
      editor: '#272822', panel: '#1e1f1c', bar: '#1e1f1c', rail: '#1e1f1c', drawer: '#272822', line: '#3e3d32', ink: '#f8f8f2',
      muted: '#90908a', accent: '#66d9ef', selection: '#414339', hover: '#3e3d32', currentLine: '#3e3d32',
      green: '#a6e22e', amber: '#e6db74', red: '#f92672',
      keyword: '#f92672', string: '#e6db74', number: '#ae81ff', type: '#66d9ef', function: '#a6e22e', comment: '#75715e',
      variable: '#f8f8f2', operator: '#f92672', attribute: '#a6e22e',
    },
    terminal: { black: '#333333', red: '#c4265e', green: '#86b42b', yellow: '#b3b42b', blue: '#6a7ec8', magenta: '#8c6bc8', cyan: '#56adbc', white: '#e3e3dd' },
  },
  {
    id: 'dracula', name: 'Dracula', kind: 'dark',
    colors: {
      editor: '#282a36', panel: '#21222c', bar: '#21222c', rail: '#21222c', drawer: '#282a36', line: '#343746', ink: '#f8f8f2',
      muted: '#7b83ad', accent: '#bd93f9', selection: '#44475a', hover: '#343746', currentLine: '#2f3141',
      green: '#50fa7b', amber: '#f1fa8c', red: '#ff5555',
      keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', type: '#8be9fd', function: '#50fa7b', comment: '#6272a4',
      variable: '#f8f8f2', operator: '#ff79c6', attribute: '#50fa7b',
    },
    terminal: { black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2' },
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night', kind: 'dark',
    colors: {
      editor: '#1a1b26', panel: '#16161e', bar: '#16161e', rail: '#16161e', drawer: '#1a1b26', line: '#292e42', ink: '#c0caf5',
      muted: '#737aa2', accent: '#7aa2f7', selection: '#283457', hover: '#202330', currentLine: '#1e202e',
      green: '#9ece6a', amber: '#e0af68', red: '#f7768e',
      keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', type: '#2ac3de', function: '#7aa2f7', comment: '#565f89',
      variable: '#c0caf5', property: '#73daca', operator: '#89ddff', tag: '#f7768e', attribute: '#bb9af7',
    },
    terminal: { black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6' },
  },
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', kind: 'dark',
    colors: {
      editor: '#1e1e2e', panel: '#181825', bar: '#181825', rail: '#11111b', drawer: '#1e1e2e', line: '#313244', ink: '#cdd6f4',
      muted: '#7f849c', accent: '#89b4fa', selection: '#313244', hover: '#26263a', currentLine: '#242436',
      green: '#a6e3a1', amber: '#f9e2af', red: '#f38ba8',
      keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', type: '#f9e2af', function: '#89b4fa', comment: '#6c7086',
      variable: '#cdd6f4', property: '#b4befe', operator: '#89dceb', tag: '#89b4fa', attribute: '#f9e2af',
    },
    terminal: { black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de' },
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', kind: 'light',
    colors: {
      editor: '#eff1f5', panel: '#e6e9ef', bar: '#e6e9ef', rail: '#dce0e8', drawer: '#eff1f5', line: '#ccd0da', ink: '#4c4f69',
      muted: '#7c7f93', accent: '#1e66f5', selection: '#ccd0da', currentLine: '#e9ecf2',
      green: '#40a02b', amber: '#df8e1d', red: '#d20f39',
      keyword: '#8839ef', string: '#40a02b', number: '#fe640b', type: '#df8e1d', function: '#1e66f5', comment: '#9ca0b0',
      variable: '#4c4f69', property: '#7287fd', operator: '#04a5e5',
    },
    terminal: { black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be' },
  },
]

/** Color fields shown in the theme editor, in display order. */
export const editableColors: { key: keyof ThemeColors; label: string; group: 'Interface' | 'Syntax' | 'Status' }[] = [
  { key: 'editor', label: 'Editor background', group: 'Interface' },
  { key: 'panel', label: 'Panels', group: 'Interface' },
  { key: 'bar', label: 'Title and status bars', group: 'Interface' },
  { key: 'line', label: 'Borders', group: 'Interface' },
  { key: 'ink', label: 'Text', group: 'Interface' },
  { key: 'muted', label: 'Muted text', group: 'Interface' },
  { key: 'accent', label: 'Accent', group: 'Interface' },
  { key: 'selection', label: 'Selection', group: 'Interface' },
  { key: 'keyword', label: 'Keywords', group: 'Syntax' },
  { key: 'string', label: 'Strings', group: 'Syntax' },
  { key: 'number', label: 'Numbers', group: 'Syntax' },
  { key: 'type', label: 'Types and classes', group: 'Syntax' },
  { key: 'function', label: 'Functions', group: 'Syntax' },
  { key: 'variable', label: 'Variables', group: 'Syntax' },
  { key: 'operator', label: 'Operators', group: 'Syntax' },
  { key: 'comment', label: 'Comments', group: 'Syntax' },
  { key: 'green', label: 'Success and additions', group: 'Status' },
  { key: 'amber', label: 'Warnings and changes', group: 'Status' },
  { key: 'red', label: 'Errors and deletions', group: 'Status' },
]

export function findTheme(id: string, custom: Theme[]) {
  return custom.find(theme => theme.id === id) ?? presets.find(theme => theme.id === id) ?? presets[0]
}

/** Accepts exported theme JSON, including VS Code-style `{ name, type, colors }` subsets. */
export function parseTheme(text: string): Theme {
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || !value.colors || typeof value.colors !== 'object') throw new Error('Theme JSON needs a "colors" object.')
  const required: (keyof ThemeColors)[] = ['editor', 'panel', 'line', 'ink', 'muted', 'accent', 'green', 'amber', 'red', 'keyword', 'string', 'number', 'type', 'function', 'comment']
  const base = value.kind === 'light' || value.type === 'light' ? presets[1] : presets[0]
  const colors = { ...base.colors } as ThemeColors
  for (const [key, color] of Object.entries(value.colors)) {
    if (typeof color === 'string' && isHex(color) && (key in base.colors || editableColors.some(item => item.key === key))) (colors as unknown as Record<string, string>)[key] = color
  }
  for (const key of required) if (!isHex(colors[key] ?? '')) throw new Error('Theme color "' + key + '" is missing.')
  return {
    id: 'custom-' + Date.now().toString(36), name: String(value.name || 'Imported theme').slice(0, 60),
    kind: value.kind === 'light' || value.type === 'light' ? 'light' : 'dark', colors,
    terminal: typeof value.terminal === 'object' ? value.terminal : undefined, custom: true,
  }
}

export function exportTheme(theme: Theme) {
  const { id: _id, custom: _custom, ...rest } = theme
  return JSON.stringify(rest, null, 2)
}
