// @flow

const fs = require('fs')
const util = require('util')
const path = require('path')

const inquirer = require('inquirer')
const yaml = require('js-yaml')
const chalk = require('chalk')
const merge = require('lodash/merge')
const diff = require('diff')

const {
  getDeployTags,
  execSyncWithEnv,
  readLocalKubeConfig,
  readLocalDockerConfig,
  ensureBinaries
} = require('./util')
const { promptQuestions } = require('./questions')

const CONFIG_FILE_PATH = 'inf'
const WWW_FILE_PATH = 'src/www'

const readFile = util.promisify(fs.readFile)
const statFile = util.promisify(fs.stat)
const writeFile = util.promisify(fs.writeFile)
const mkdir = util.promisify(fs.mkdir)

async function deployNodeApp (packageJson /*: Object */, env /*: string */, opts /*: Object */) {
  const output = opts.output
  const silence = output === '-'
  const prompts = !opts.confirm
  const overwrite = opts.overwrite
  const cwd = process.cwd()
  const execOpts = {
    stdio: [process.stdin, opts.output !== '-' ? process.stdout : null, process.stderr]
  }
  let svcMsg = ''

  function log () {
    if (silence) return
    // eslint-disable-next-line no-console
    console.log(...arguments)
  }

  function fatal (msg) {
    console.error(chalk.red(`>> ${msg}`))
    process.exit(1)
  }

  const handleUi = await statFile(WWW_FILE_PATH)

  const format = ['kube', 'kubernetes', 'k8s'].includes(opts.format)
    ? 'k8s'
    : opts.format === 'compose'
      ? 'compose'
      : null
  if (!format) {
    fatal('ERROR: Unsupported format option provided!')
    process.exit(1)
  }

  /**
   * Discovers "meta-module" packages within the package.json dep tree
   * Returns an array of package.json blobs from deps marked with a special key
   */
  async function findMetaModules (packageJson /*: Object */) /*: Array<Object> */ {
    const depNames = Object.keys(packageJson.dependencies)
    const readFiles = depNames.map(async dep => {
      try {
        return await readFile(path.join('node_modules', dep, 'package.json')).then(json =>
          JSON.parse(json)
        )
      } catch (err) {
        console.error('Unable to load package.json:', err.message)
        return Promise.resolve(null)
      }
    })
    const files = await Promise.all(readFiles)
    // filter out deps without a package.json and without any specified deployments
    return files
      .filter(file => file !== null)
      .filter(file => file['deploy-node-app'] && file['deploy-node-app'].metamodule === true)
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
    for (let i = 0; i < metaModules.length; i++) {
      const mm = metaModules[i]
      const metadata = mm['deploy-node-app']
      const configFile = metadata.config || 'lib/config.js'
      if (await statFile(`node_modules/${mm.name}/${configFile}`)) {
        try {
          // eslint-disable-next-line security/detect-non-literal-require
          const vars = require(path.join(cwd, 'node_modules', mm.name, configFile))
          for (const env in vars) {
            log(
              `WARN: MetaModule "${
                mm.name
              }" overwrites an already existing environment variable, "${env}"!`
            )
            envVars[env] = vars[env]
          }
        } catch (err) {
          fatal(
            `Unable to include MetaModule "${
              mm.name
            }"'s configuration file!\nConfig file: "${configFile}\n"`,
            err.message
          )
        }
      }
      if (metadata.ports) {
        for (const portName in metadata.ports) {
          const portSpec = metadata.ports[portName]
          const name = metadata.containerName || mm.name.split('/').pop()
          if (detectPorts === 'compose') {
            envVars = Object.assign({}, envVars, await detectComposePorts(name, portName, portSpec))
          } else if (detectPorts) {
            fatal(
              'generateLocalEnv() detectPorts is only available via docker-compose for now, sorry!'
            )
          }
        }
      }
      // TODO: For now, we'll assume the local environment is docker-compose, and use localhost
      // This should be improved to support remote docker, by checking for DOCKER_HOST
      // If kubernetes, we can kubectl proxy && use localhost, or try to use cluster address?
      // Or prompt?
      if (metadata.host) {
        envVars[metadata.host] = 'localhost'
      }
    }
    return envVars
  }

  function buildComposeFile (metaModules /*: Array<Object> */) {
    let services = {}
    metaModules.forEach(dependency => {
      const filename = `./node_modules/${dependency.name}/docker-compose.yaml`
      if (fs.existsSync(filename)) {
        const config = yaml.safeLoad(fs.readFileSync(filename))
        services = Object.assign({}, services, config.services)
      } else {
        process.stdout.write('Warning:', dependency.name, 'doesn\'t support Docker Compose mode\n')
      }
    })

    return {
      version: '2',
      services
    }
  }

  async function tryDiff (content /*: string */, existingPath /*: string */) {
    const existing = (await readFile(existingPath)).toString()
    const compare = diff.diffLines(existing, content)
    compare.forEach(part =>
      process.stdout.write(
        part.added ? chalk.green(part.value) : part.removed ? chalk.red(part.value) : part.value
      )
    )
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
    let composeFileFound
    try {
      composeFileFound = await statFile(`${cwd}/docker-compose.yaml`)
    } catch {}
    if (!composeFileFound) {
      log(
        'WARN: It doesn\'t look like docker-compose is used here, so I can\'t automatically detect ports for you - using default values!'
      )
      return {}
    }
    const containers = (await execSyncWithEnv(`docker-compose ps -q ${name}`)).split('\n')
    if (containers.length === 1 && containers[0] === '') {
      fatal(
        'Failed to discover ports. You have some containers that are not yet running. Please run "docker-compose up" first.'
      )
    }
    for (const container of containers) {
      ports[portName] = await execSyncWithEnv(
        `docker inspect ${container} --format='{{(index (index .NetworkSettings.Ports "${portSpec}") 0).HostPort}}'`
      )
    }
    return ports
  }

  function checkForGitIgnored (pattern /*: string */) {
    let ignored
    try {
      ignored = execSyncWithEnv(`git grep '^${pattern}/$' .gitignore`)
    } catch (err) {}
    if (!ignored) {
      log(`WARN: It doesn't look like you have ${pattern} ignored by your .gitignore file!`)
      log(`WARN: This is usually a bad idea! Fix with: "echo '${pattern}' >> .gitignore"`)
    }
    return ignored
  }

  /**
   *
   * The meat and potatoes of Deploy-Node-App, confirmWriteFile takes either a string of content or a template file
   * and copies it to the users directory. It will prompt the user, unless:
   *   --overwrite is set, in which case any changes will be writen without asking
   *   -o - is set, in which case we will write our outputs to stdout, not prompting and not writing
   * confirmWriteFile also supports diffing!
   * Provide only one of content or templatePath!
   */
  async function confirmWriteFile (
    filePath /*: string */,
    {
      content,
      templatePath,
      output,
      properties
    } /*: {
      content: string,
      templatePath: string,
      output: string,
      properties: Object|void
    } */
  ) {
    const fullPath = path.join(cwd, filePath)
    const fullTemplatePath = templatePath ? path.join(__dirname, templatePath) : null

    let template
    if (templatePath) {
      template = (await readFile(fullTemplatePath)).toString()
      if (properties && templatePath.endsWith('.yaml')) {
        template = yaml.safeLoad(template)
        merge(template, properties)
        template = yaml.safeDump(template) + '\n'
      }
    }

    if (content && templatePath) throw new Error('Provide only one of content, templatePath')
    let doWrite = false
    let existingContent
    try {
      existingContent = (await readFile(fullPath)).toString()
    } catch {}
    if (overwrite) {
      doWrite = true
    } else {
      if (output !== '-') {
        // If existing file matches the content we're about to write, then bail early
        if (existingContent === (content || template)) {
          return false
        }
      }

      if (existingContent && prompts && !silence) {
        const YES_TEXT = 'Yes (overwrite)'
        const NO_TEXT = 'No, dont touch'
        const SHOWDIFF_TEXT = 'Show diff'
        const confirmOverwrite = (await inquirer.prompt({
          name: 'overwrite',
          type: 'expand',
          message: `Would you like to overwrite "${filePath}"?`,
          choices: [
            { key: 'Y', value: YES_TEXT },
            { key: 'N', value: NO_TEXT },
            { key: 'D', value: SHOWDIFF_TEXT }
          ],
          default: 0
        })).overwrite
        if (confirmOverwrite === YES_TEXT) doWrite = true
        else if (confirmOverwrite === SHOWDIFF_TEXT) {
          await tryDiff(content || template, fullPath)
          await confirmWriteFile(filePath, { templatePath, content, properties })
        }
      } else if (existingContent && !prompts) {
        log(
          `Refusing to overwrite "${filePath}"... Continuing... (Use --overwrite to ignore this check)`
        )
      } else if (!existingContent) {
        doWrite = true
      }
    }

    if (!doWrite && output !== '-') {
      return false
    } else if (content || template) {
      try {
        if (output === '-') process.stdout.write((content || template) + '\n')
        else await writeFile(fullPath, content || template)
        log(`Successfully ${content ? 'wrote' : 'wrote from template'} "${filePath}"`)
      } catch (err) {
        fatal(`Error writing ${filePath}: ${err.message}`)
      }
      return true
    } else throw new Error('Please provide one of content, templatePath for confirmWriteFile')
  }

  async function buildKustomize (
    metaModules /*: Array<Object> */,
    { bases = [] /*: Array<string> */, resources = [] /*: Array<string> */ }
  ) {
    for (let i = 0; i < metaModules.length; i++) {
      const mm = metaModules[i]
      if (await statFile(`./node_modules/${mm.name}/kustomization.yaml`)) {
        bases.push(`../node_modules/${mm.name}`)
      } else {
        process.stdout.write('Warning:', mm.name, 'doesn\'t support Kustomize mode\n')
      }
    }
    return { bases, resources }
  }

  //
  // Begin deploy-node-app
  //

  const metaModules = await findMetaModules(packageJson)

  // deploy-node-app --generate-local-env
  if (opts.generateLocalEnv) {
    const envVars = await generateLocalEnv(metaModules, opts.format)
    const envVarLines = []
    for (const env in envVars) {
      envVarLines.push(`${env}=${envVars[env]}`)
    }
    const content = envVarLines.join('\n') + '\n'
    checkForGitIgnored('.env')
    if (output === '-') process.stdout.write(content)
    else await confirmWriteFile('.env', { content, output })
    return null
  }

  ensureBinaries() // Ensure 'kubectl', 'docker', etc...
  const kubeContexts = readLocalKubeConfig()
  const containerRegistries = readLocalDockerConfig()
  const answers = await promptQuestions(env, containerRegistries, kubeContexts, packageJson)
  const tags = await getDeployTags(packageJson.name, answers, opts.build)

  if (!packageJson['deploy-node-app']) packageJson['deploy-node-app'] = {}
  packageJson['deploy-node-app'][env] = answers

  await confirmWriteFile('package.json', { content: JSON.stringify(packageJson, null, 2) + '\n' })
  await confirmWriteFile('Dockerfile', { templatePath: 'defaults/Dockerfile' })
  await mkdir(CONFIG_FILE_PATH, { recursive: true })
  if (opts.format === 'k8s') {
    const backendDeployment = `${handleUi ? 'backend-' : ''}deployment.yaml`
    const backendService = `${handleUi ? 'backend-' : ''}service.yaml`
    const frontendDeployment = 'frontend-deployment.yaml'
    const frontendService = 'frontend-service.yaml'
    const frontendConfigMap = 'frontend-configmap.yaml'

    const resources = []
    // Write deployment config for Node app
    resources.push('./' + backendDeployment)
    await confirmWriteFile(`${CONFIG_FILE_PATH}/${backendDeployment}`, {
      templatePath: 'defaults/backend-deployment.yaml',
      properties: {
        metadata: {
          name: packageJson.name + (handleUi ? '-backend' : ''),
          labels: { app: packageJson.name }
        },
        spec: {
          selector: { matchLabels: { app: packageJson.name } },
          template: {
            metadata: {
              labels: { app: packageJson.name }
            },
            spec: {
              containers: [
                {
                  image: tags.hash,
                  name: packageJson.name,
                  command: ['node', answers.entrypoint],
                  ports: [{ containerPort: answers.port }]
                }
              ]
            }
          }
        }
      }
    })
    // Write service config for Node app
    resources.push('./' + backendService)
    await confirmWriteFile(`${CONFIG_FILE_PATH}/${backendService}`, {
      templatePath: 'defaults/backend-service.yaml',
      properties: {
        metadata: {
          name: packageJson.name + (handleUi ? '-backend' : '')
        },
        spec: {
          selector: { app: packageJson.name },
          ports: [{ port: answers.port, targetPort: answers.port }]
        }
      }
    })

    // Write deployment config for WWW
    if (handleUi) {
      // Write Nginx ConfigMap
      resources.push('./' + frontendConfigMap)
      await confirmWriteFile(`${CONFIG_FILE_PATH}/${frontendConfigMap}`, {
        templatePath: 'defaults/frontend-configmap.yaml',
        properties: {
          data: {
            default: `
              error_log stderr info;
              server {
                access_log stdout;
                listen 80;
                root /app/build;
                location /api {
                  proxy_pass http://${packageJson.name}-backend:${answers.port};
                }
              }`
          }
        }
      })
      // Write Nginx Deployment
      resources.push('./' + frontendDeployment)
      await confirmWriteFile(`${CONFIG_FILE_PATH}/${frontendDeployment}`, {
        templatePath: 'defaults/frontend-deployment.yaml',
        properties: {
          metadata: {
            name: `${packageJson.name}-frontend`,
            labels: { app: packageJson.name }
          },
          spec: {
            selector: { matchLabels: { app: packageJson.name } },
            template: {
              metadata: { labels: { app: packageJson.name } },
              spec: {
                containers: [
                  {
                    image: tags.hash,
                    name: packageJson.name
                  }
                ]
              }
            }
          }
        }
      })
      // Write Nginx Service Config
      const exposeExternally = true // TODO for kubesail only
      const namespace = 'pastudan' // TODO get from kubesail context
      const host = `${packageJson.name}-frontend--${namespace}.kubesail.io`
      svcMsg += exposeExternally
        ? '\nYour App is available at:' + `\n\n    ${chalk.cyan(`https://${host}\n`)}\n\n`
        : '\nYou may need to expose your deployment on kubernetes via a service.\n' +
          'Learn more: https://kubernetes.io/docs/tutorials/kubernetes-basics/expose/expose-intro/.\n'
      resources.push('./' + frontendService)
      await confirmWriteFile(`${CONFIG_FILE_PATH}/${frontendService}`, {
        templatePath: 'defaults/frontend-service.yaml',
        properties: {
          metadata: {
            name: `${packageJson.name}-frontend`,
            annotations: exposeExternally
              ? {
                'getambassador.io/config': yaml.safeDump({
                  apiVersion: 'ambassador/v1',
                  kind: 'Mapping',
                  name: `${packageJson.name}-frontend.${namespace}`,
                  prefix: '/',
                  service: `http://${packageJson.name}-frontend.${namespace}:80`,
                  host, // TODO allow custom domains
                  timeout_ms: 10000,
                  use_websocket: true
                })
              }
              : null
          },
          spec: { selector: { app: packageJson.name } }
        }
      })
    }
    // Write kustomization config
    await confirmWriteFile(`${CONFIG_FILE_PATH}/kustomization.yaml`, {
      content: yaml.safeDump(await buildKustomize(metaModules, { resources }))
    })
  } else {
    const composeFileData = buildComposeFile(metaModules)
    const composeFileDataYAML = yaml.safeDump(composeFileData)
    await confirmWriteFile('docker-compose.yaml', {
      content: composeFileDataYAML + '\n',
      output
    })
    // TODO: Write docker compose for static files / nginx
  }

  await confirmWriteFile('.dockerignore', { templatePath: 'defaults/.dockerignore' })

  // Build
  if (opts.build) {
    log(`Now building "${tags.hash}"`)
    try {
      execSyncWithEnv(`docker build . -t ${tags.hash}`, execOpts)
    } catch (err) {
      console.error('Docker build failed!', err.message, err.stack)
      process.exit(1)
    }
  }

  // Deploy
  if (opts.deploy) {
    log(`Now deploying "${tags.hash}"`)
    execSyncWithEnv(`docker push ${tags.hash}`, execOpts)

    if (opts.format === 'k8s') {
      const cmd = `kubectl --context=${answers.context} apply -k ${CONFIG_FILE_PATH}`
      log(`Running: \`${cmd}\``)
      execSyncWithEnv(cmd, execOpts)
      // Deploy service
    } else {
      execSyncWithEnv('docker-compose up --remove-orphans --quiet-pull -d')
    }

    process.stdout.write(`\n\n✨  Your application has been deployed! ✨\n\n${svcMsg}`)
  }
}

module.exports = {
  deployNodeApp
}
