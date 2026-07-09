const fs = require('fs')
const path = require('path')

const files = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'binding.gyp'),
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp')
]

for (const p of files) {
  if (!fs.existsSync(p)) {
    console.log('skip missing', p)
    continue
  }
  let s = fs.readFileSync(p, 'utf8')
  const next = s.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'")
  if (next === s) {
    console.log('already patched or no Spectre line:', path.relative(process.cwd(), p))
  } else {
    fs.writeFileSync(p, next)
    console.log('patched', path.relative(process.cwd(), p))
  }
}
