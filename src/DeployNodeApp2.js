// @flow

const fs = require('fs')
const util = require('util')
const path = require('path')

const inquirer = require('inquirer')
const yaml = require('js-yaml')
const style = require('ansi-styles')

const {
  getDeployTags,
  execSyncWithEnv,
  readLocalKubeConfig,
  readLocalDockerConfig,
  readKubeConfigNamespace,
  shouldUseYarn,
  fatal,
  WARNING,
  ensureBinaries
} = require('./util')
const { promptQuestions } = require('./questions')

const cwd = process.cwd()
const readFile = util.promisify(fs.readFile)
const statFile = util.promisify(fs.stat)
const writeFile = util.promisify(fs.writeFile)
const copyFile = util.promisify(fs.copyFile)

/**
 * Discovers "meta-module" packages within the package.json dep tree
 * Returns an array of package.json blobs from deps marked with a special key
 */
async function findMetaModules (packageJson /*: Object */) /*: Array<Object> */ {
  const depNames = Object.keys(packageJson.dependencies)
  const readFiles = depNames.map(async dep => {
    try {
      return await readFile(`node_modules/${dep}/package.json`).then(json => JSON.parse(json))
    } catch (err) {
      return Promise.resolve(null)
    }
  })
  const files = await Promise.all(readFiles)
  // filter out deps without a package.json and without any specified deployments
  return files.filter(file => file !== null).filter(file => !!file['deploy-node-app'])
}

/**
 * Concatenates all environment variables from all metamodules
 * Returns a flat object of KEYS and VALUES where KEYS are environment variables and VALUES are their data
 */
async function generateLocalEnv (
  metaModules /*: Array<Object> */,
  detectPorts /*: void|'compose'|'k8s' */
) /*: Array<Object> */ {
  let envVars = {}
  const ports = {}
  for (let i = 0; i < metaModules.length; i++) {
    const mm = metaModules[i]
    if (await statFile(`node_modules/${mm.name}/lib/config.js`)) {
      // eslint-disable-next-line security/detect-non-literal-require
      const vars = require(`${process.cwd()}/node_modules/${mm.name}/lib/config`)
      for (const env in vars) {
        envVars[env] = vars[env]
      }
    }
    if (mm['deploy-node-app'].ports) {
      for (const portName in mm['deploy-node-app'].ports) {
        const portSpec = mm['deploy-node-app'].ports[portName]
        const name = mm['deploy-node-app'].containerName || mm.name.split('/').pop()
        if (detectPorts === 'compose') {
          envVars = Object.assign({}, envVars, await detectComposePorts(name, portName, portSpec))
        } else if (detectPorts) {
          fatal(
            'generateLocalEnv() detectPorts is only available via docker-compose for now, sorry!'
          )
        }
      }
    }
  }
  return envVars
}

/**
 * Calls on docker-compose to provide us with port mapping information
 * In other words, if we know redis has a docker port assignment of 6379/tcp, we can
 * try our best to find the randomized hostPort. This allows for zero port conflicts between projects1
 * as well as a sort of "forced best practice", in that the driver -must- obey the randomized PORT value to work!
 */
async function detectComposePorts (
  name /*: string */,
  portName /*: string */,
  portSpec /*: string */
) {
  const ports = {}
  const containers = (await execSyncWithEnv(`docker-compose ps -q ${name}`)).split('\n')
  for (const container of containers) {
    ports[portName] = await execSyncWithEnv(
      `docker inspect ${container} --format='{{(index (index .NetworkSettings.Ports "${portSpec}") 0).HostPort}}'`
    )
  }
  return ports
}

/**
 * Top level wrapper for Deploy Node App
 */
async function deployNodeApp (packageJson /*: Object */, env /*: string */, opts /*: Object */) {
  const metaModules = await findMetaModules(packageJson)
  const output = opts.output
  const silence = output === '-'
  const prompts = opts.confirm
  const overwrite = opts.overwrite

  function log () {
    if (silence) return
    // eslint-disable-next-line no-console
    console.log(...arguments)
  }

  function fatal () {
    // eslint-disable-next-line no-console
    console.error('FATAL', ...arguments)
    process.exit(1)
  }

  async function confirmWriteFile (
    {
      path,
      content,
      copySource,
      noPrompts
    } /*: { path: string, content: string, copySource: string, noPrompts: boolean } */
  ) {
    const fullPath = `${cwd}/${path}`
    const fullCopySource = `${__dirname}/${copySource}`
    let doWrite = false
    if (overwrite) doWrite = true
    else {
      let exists = false
      try {
        exists = await statFile(fullPath)
      } catch (err) {}
      if (exists && prompts && !noPrompts) {
        const YES_TEXT = 'Yes (overwrite)'
        const NO_TEXT = 'No, dont touch'
        const SHOWDIFF_TEXT = 'Show diff'
        const confirmOverwrite = (await inquirer.prompt({
          name: 'overwrite',
          type: 'expand',
          message: `Would you like to overwrite "${path}"?`,
          choices: [
            { key: 'Y', value: YES_TEXT },
            { key: 'N', value: NO_TEXT },
            { key: 'D', value: SHOWDIFF_TEXT }
          ],
          default: 0
        })).overwrite
        if (confirmOverwrite === YES_TEXT) doWrite = true
        else if (confirmOverwrite === SHOWDIFF_TEXT) {
          if (copySource) {
            try {
              execSyncWithEnv(`git diff ${fullCopySource} ${fullPath}`)
            } catch (err) {
              process.stdout.write(err.output.toString('utf8') + '\n')
            }
          } else {
            console.log('Not supported yet')
          }
          await confirmWriteFile({ path, content, copySource, noPrompts })
        }
      } else if (exists && !prompts) {
        log(
          `Refusing to overwrite "${path}"... Continuing... (Use --overwrite to ignore this check)`
        )
      } else if (!exists) {
        doWrite = true
      }
    }
    if (!doWrite) {
      return false
    } else if (content || copySource) {
      try {
        if (content) writeFile(fullPath, content)
        else if (copySource) copyFile(fullCopySource, path)
        log(`Successfully ${content ? 'wrote' : 'wrote from template'} "${path}"`)
      } catch (err) {
        fatal(`Error writing ${path}:`, err.message)
      }
      return true
    } else throw new Error('Please provide one of content, copySource for confirmWriteFile')
  }

  if (opts.generateLocalEnv) {
    const envVars = await generateLocalEnv(metaModules, opts.format)
    const envVarLines = []
    for (const env in envVars) {
      envVarLines.push(`${env}=${envVars[env]}`)
    }
    await confirmWriteFile({ path: '.env', content: envVarLines.join('\n') + '\n' })
    let ignored
    try {
      ignored = execSyncWithEnv('git grep \'^.env$\' .gitignore')
    } catch (err) {}
    if (!ignored) {
      log(
        'WARN: It doesnt look like you have .env ignored by your .gitignore file! This is usually a bad idea! Fix with: "echo .env >> .gitignore"'
      )
    }
    return null
  }

  const kubeContexts = readLocalKubeConfig()
  const containerRegistries = readLocalDockerConfig()
  const answers = await promptQuestions(env, containerRegistries, kubeContexts, packageJson)
  const tags = await getDeployTags(packageJson.name, env, answers, opts.build)

  packageJson['deploy-node-app'] = {
    [env]: answers
  }
  await confirmWriteFile({
    path: 'package.json',
    content: JSON.stringify(packageJson, null, 2),
    noPrompts: true
  })

  await confirmWriteFile({
    path: 'Dockerfile',
    copySource: 'defaults/Dockerfile'
  })

  let infDirExists = false
  try {
    infDirExists = await statFile('inf')
  } catch {}
  if (!infDirExists) fatal('There is no ./inf directory in this repository!')

  await confirmWriteFile({
    path: 'inf/node-deployment.yaml',
    copySource: 'defaults/deployment.yaml'
  })
}

module.exports = {
  deployNodeApp
}
