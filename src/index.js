#!/usr/bin/env node

const USAGE = '[env] [action]'

const program = require('commander')
const { fatal } = require('./util')
const deployNodeApp = require('./deployNodeApp')
const dnaPackageJson = require(__dirname + '/../package.json') // eslint-disable-line

const languages = [
  require('./languages/nginx'),
  require('./languages/nodejs'),
  require('./languages/php'),
  require('./languages/python')
]

let env
let action

program
  .name('deploy-to-kube')
  .arguments(USAGE)
  .usage(USAGE)
  .version(dnaPackageJson.version)
  .action((_env, _action) => {
    env = _env
    action = _action
  })
  .option('-w, --write', 'Write files to project (writes out Dockerfile, skaffold.yaml, etc)', false)
  .option('-u, --update', 'Update existing files', false)
  .option('-f, --force', 'Dont prompt if possible (implies --write and --update)', false)
  .option('-l, --label [foo=bar,tier=service]', 'Add labels to created Kubernetes resources')
  .option('-d, --directory <path/to/project>', 'Target project directory', '.')
  .option('-c, --config <path/to/kubeconfig>', 'Kubernetes configuration file', '~/.kube/config')
  .parse(process.argv)

async function DeployNodeApp () {
  for (let i = 0; i < languages.length; i++) {
    const language = languages[i]
    const detect = await language.detect()
    if (!detect) continue
    deployNodeApp(env || 'production', action || 'deploy', language, {
      action: action || 'deploy',
      write: program.write || false,
      update: program.update || false,
      force: program.force || false,
      directory: program.directory || process.cwd(),
      labels: (program.label || '').split(',').map(k => k.split('=').filter(Boolean)).filter(Boolean)
    })
    return
  }

  fatal('Unable to determine what sort of project this is. If it\'s a real project, please let us know at https://github.com/kubesail/deploy-node-app/issues and we\'ll add support!')
}

DeployNodeApp()
