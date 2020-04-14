const fs = require('fs')
const path = require('path')
// eslint-disable-next-line security/detect-child-process
const execSync = require('child_process').execSync
const util = require('util')
const stream = require('stream')
const chalk = require('chalk')
const diff = require('diff')
const inquirer = require('inquirer')
const style = require('ansi-styles')
const commandExists = require('command-exists')
const got = require('got')

const pipeline = util.promisify(stream.pipeline)
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)
const ERR_ARROWS = `${style.red.open}>>${style.red.close}`

// A stub logger for now
function log () { console.log(...arguments) } // eslint-disable-line no-console

// Fatal is like log, but exits the process
function fatal (message /*: string */) {
  process.stderr.write(`${ERR_ARROWS} ${message}\n`)
  process.exit(1)
}

// Diffs two strings prettily to stdout
function tryDiff (content /*: string */, existingData /*: string */) {
  const compare = diff.diffLines(existingData, content)
  compare.forEach(part =>
    process.stdout.write(
      part.added ? chalk.green(part.value) : part.removed ? chalk.red(part.value) : part.value
    )
  )
}

// Writes a file unless it already exists, then properly handles that
// Can also diff before writing!
async function confirmWriteFile (filePath, content, options = { update: false, force: false }) {
  const fullPath = path.join(process.cwd(), filePath)
  const { update, force } = options

  const exists = fs.existsSync(fullPath)
  let doWrite = !exists
  if (!update && exists) return false
  else if (exists && update && !force) {
    const existingData = (await readFile(fullPath)).toString()
    if (content === existingData) return false

    const YES_TEXT = 'Yes (update)'
    const NO_TEXT = 'No, dont touch'
    const SHOWDIFF_TEXT = 'Show diff'
    const confirmUpdate = (
      await inquirer.prompt({
        name: 'update',
        type: 'expand',
        message: `Would you like to update "${filePath}"?`,
        choices: [
          { key: 'Y', value: YES_TEXT },
          { key: 'N', value: NO_TEXT },
          { key: 'D', value: SHOWDIFF_TEXT }
        ],
        default: 0
      })
    ).update
    if (confirmUpdate === YES_TEXT) doWrite = true
    else if (confirmUpdate === SHOWDIFF_TEXT) {
      tryDiff(content, existingData)
      await confirmWriteFile(filePath, content, options)
    }
  } else if (force) {
    doWrite = true
  }

  if (doWrite) {
    try {
      await writeFile(fullPath, content)
      log(`Successfully wrote "${filePath}"`)
    } catch (err) {
      fatal(`Error writing ${filePath}: ${err.message}`)
    }
    return true
  }
}

// Runs a shell command with our "process.env" - allows passing environment variables to skaffold, for example.
const execSyncWithEnv = (cmd, options = {}) => {
  const mergedOpts = Object.assign({}, options, {
    catchErr: true,
    env: Object.assign({}, process.env, options.env || {})
  })
  let output
  try {
    output = execSync(cmd, mergedOpts)
  } catch (err) {
    if (mergedOpts.catchErr) {
      fatal(`Command "${cmd}" failed to run`)
      process.exit(1)
    } else {
      throw err
    }
  }
  if (output) return output.toString().trim()
}

// Ensures other applications are installed (eg: skaffold)
async function ensureBinaries () {
  const existsInNodeModules = fs.existsSync('./node_modules/.bin/skaffold')
  const existsInPath = commandExists.sync('skaffold')
  if (!existsInNodeModules && !existsInPath) {
    const { downloadSkaffold } = await inquirer.prompt([
      {
        name: 'downloadSkaffold',
        type: 'confirm',
        message: 'Can\'t find a local "skaffold" installed - Try to download one automatically?'
      }
    ])
    if (!downloadSkaffold) return fatal('Please install skaffold manually - see https://skaffold.dev/docs/install/')
    let skaffoldUri = ''
    switch (process.platform) {
      case 'darwin':
        skaffoldUri = 'https://storage.googleapis.com/skaffold/releases/latest/skaffold-darwin-amd64'; break
      case 'linux':
        skaffoldUri = 'https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64'; break
      case 'win32':
        skaffoldUri = 'https://storage.googleapis.com/skaffold/releases/latest/skaffold-windows-amd64.exe'; break
      default:
        return fatal('Can\'t determine platform! Please download skaffold manually - see https://skaffold.dev/docs/install/')
    }
    if (skaffoldUri) await pipeline(got.stream(skaffoldUri), fs.createWriteStream('./node_modules/.bin/skaffold'))
  }
  return existsInPath ? 'skaffold' : './node_modules/.bin/skaffold'
}

async function promptUserForValue ({ message, generateRandom = false, validate, type = 'input' }) {
  const { value } = await inquirer.prompt([{ name: 'value', type, message, validate }])
  return value
}

module.exports = {
  fatal,
  log,
  ensureBinaries,
  confirmWriteFile,
  execSyncWithEnv,
  promptUserForValue
}
