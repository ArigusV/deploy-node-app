#!/usr/bin/env node
// @flow

const DNA_VERSION = '0.0.1'
const USAGE = '[env]'

const inquirer = require('inquirer')
// TODO use inquirer-fuzzy-path for entrypoint question
const fs = require('fs')
const program = require('commander')
const yaml = require('js-yaml')
const uuidv4 = require('uuid/v4')
const opn = require('opn')
const WebSocket = require('ws')
const ansiStyles = require('ansi-styles')
const errArrows = `${ansiStyles.red.open}>>${ansiStyles.red.close}`
const homedir = require('os').homedir()
const path = require('path')
// eslint-disable-next-line security/detect-child-process
const execSync = require('child_process').execSync

const KUBESAIL_WEBSOCKET_HOST = 'wss://localhost:4000'
const KUBESAIL_WWW_HOST = 'https://localhost:3000'
const KUBESAIL_REGISTRY = 'registry.kubesail.io'

function fatal (message /*: string */) {
  process.stderr.write(`${errArrows} ${message}\n`)
  process.exit(1)
}

if (!fs.existsSync('package.json')) {
  fatal('This doesn\'t appear to be a Node.js application - run \'npm init\'?')
}

function promptQuestions (
  env /*: string */,
  containerRegistries /*: Array<string> */,
  kubeContexts /*: Array<string> */
) {
  // TODO: dont prompt for the above if answers exist in package.json?
  return inquirer.prompt([
    {
      name: 'env',
      type: 'input',
      message: 'Which environment are you deploying to?',
      default: env,
      validate: function (input) {
        if (input !== input.toLowerCase()) return 'environment names must be lowercase'
        if (input.length < 3) return 'environment names must be longer than 2 characters'
        if (!input.match(/^[a-zA-Z0-9-_]+$/)) {
          return 'environment names need to be numbers, letters, and dashes only'
        }
        return true
      }
    },
    {
      name: 'port',
      type: 'input',
      message: 'What port does your application listen on?',
      default: '3000',
      validate: function (input) {
        if (isNaN(parseInt(input, 10))) return 'ports must be numbers!'
        return true
      }
    },
    {
      name: 'protocol',
      type: 'list',
      message: 'Which protocol does your application speak?',
      default: 'http',
      choices: ['http', 'https', 'tcp']
    },
    {
      name: 'entrypoint',
      type: 'input',
      message: 'Where is your application\'s entrypoint?',
      default: 'index.js',
      validate: function (input) {
        if (!fs.existsSync(input)) return 'That file doesn\'t seem to exist'
        return true
      }
    },
    {
      name: 'context',
      type: 'list',
      message: 'Which Kubernetes context do you want to use?',
      default: kubeContexts[0],
      choices: kubeContexts
    },
    {
      name: 'registry',
      type: 'list',
      message: 'Which docker registry do you want to use?',
      choices: containerRegistries,
      validate: function (registry) {
        if (!registry.match(/^([a-z0-9]+\.)+[a-z0-9]$/i)) {
          return 'You must provide a valid hostname for a docker registry'
        }
        return true
      }
    }
  ])
}

// Only works for kubectl and docker, as they both respond postively to `{command} version`
// The `docker version` command will contact the docker server, and error if it cannot be reached
function checkProgramVersion (input /*: string */) {
  try {
    execSync(`${input} version`)
  } catch (err) {
    return false
  }
  return true
}

function readLocalDockerConfig () {
  // Read local .docker configuration to see if the user has container registries already
  let containerRegistries = []
  const dockerConfigPath = path.join(homedir, '.docker', 'config.json')
  if (fs.existsSync(dockerConfigPath)) {
    try {
      const dockerConfig = JSON.parse(fs.readFileSync(dockerConfigPath))
      containerRegistries = containerRegistries.concat(Object.keys(dockerConfig.auths))
    } catch (err) {
      fatal(
        `It seems you have a Docker config.json file at ${dockerConfigPath}, but it is not valid json, or unreadable!`
      )
    }
  }
  containerRegistries.push(KUBESAIL_REGISTRY)
  return containerRegistries
}

function readLocalKubeConfig () {
  // Read local .kube configuration to see if the user has an existing kube context they want to use
  let kubeContexts = []
  const kubeConfigPath = path.join(homedir, '.kube', 'config')
  if (fs.existsSync(kubeConfigPath)) {
    try {
      const kubeConfig = yaml.safeLoad(fs.readFileSync(kubeConfigPath))

      kubeContexts = kubeContexts.concat(
        kubeConfig.contexts
          .map(
            context =>
              context.name || ((context.context && context.context.name) || context.context.cluster)
          )
          .filter(context => context)
      )
    } catch (err) {
      fatal(
        `It seems you have a Kubernetes config file at ${kubeConfigPath}, but it is not valid yaml, or unreadable!`
      )
    }
  }
  kubeContexts.push('kubesail')
  return kubeContexts
}

async function DeployNodeApp (env /*: string */) {
  if (!checkProgramVersion('docker')) {
    fatal('Error - You might need to install or start docker! https://www.docker.com/get-started')
  }
  if (!checkProgramVersion('kubectl')) {
    fatal(
      'Error - You might need to install kubectl! https://kubernetes.io/docs/tasks/tools/install-kubectl/'
    )
  }
  const kubeContexts = readLocalKubeConfig()
  const containerRegistries = readLocalDockerConfig()
  const answers = await promptQuestions(env, containerRegistries, kubeContexts)

  // 2. TODO: detect docker server / help user setup if not present
  // TODO: write config from above into package.json
  // 6. TODO: docker build
  // 7. TODO: docker push
  // TODO: create kube documents
  // 8. TODO: kubectl deploy

  if (answers.registry === KUBESAIL_REGISTRY) {
    connectKubeSail()
  }

  console.log(answers)
}

function connectKubeSail () {
  let ws
  const connect = function () {
    ws = new WebSocket(`${KUBESAIL_WEBSOCKET_HOST}/socket.io/`)
    ws.on('open', function () {})
    ws.on('error', function () {})
    ws.on('close', function () {
      setTimeout(connect, 250)
    })
  }
  connect()

  ws.on('connect', function () {})

  const session = uuidv4()
  opn(`${KUBESAIL_WWW_HOST}/register?session=${session}`)
}

program
  .arguments('[env]')
  .usage(USAGE)
  .version(DNA_VERSION)
  // .option('-A, --auto', 'Deploy without asking too many questions!')
  .parse(process.argv)

// Default to production environment
// TODO: Pass auto argument (and others) to DeployNodeApp
DeployNodeApp(program.args[0] || 'production')
