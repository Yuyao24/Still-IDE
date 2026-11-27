// The parts of nspell (a Hunspell-compatible spell checker) that Still uses.
declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string): NSpell
  }
  export default function nspell(dictionary: { aff: string; dic: string }): NSpell
}
