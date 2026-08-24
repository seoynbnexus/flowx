import 'dotenv/config'
import { decrypt } from '../shared/utils/crypto.utils.js'

const input = process.argv[2]
if (!input) {
  console.error('usage: node scripts/decode-token.js <iv:ciphertext>')
  process.exit(1)
}
console.log(decrypt(input.trim()))
