// @flow

const fs = require('fs')
const util = require('util')
const yaml = require('js-yaml')

const readFile = util.promisify(fs.readFile)

async function buildDependencyConfig (pkg, format = 'compose') {
  const depNames = Object.keys(pkg.dependencies)
  const readFiles = depNames.map(async dep => {
    try {
      return await readFile(`node_modules/${dep}/package.json`).then(json => JSON.parse(json))
    } catch (err) {
      return Promise.resolve(null)
    }
  })
  let files = await Promise.all(readFiles)

  // filter out deps without a package.json, or without any specified deployments
  files = files.filter(file => file !== null).filter(file => !!file['deploy-node-app'])

  const config = format === 'compose' ? buildCompose(files) : buildKube(files)
  return yaml.safeDump(config)
}

function buildCompose (files) {
  // Point of confusion: In Docker Compose, "services" are analagous to Kube "deployments",
  // meaning if you define a "service" you want a container running for that object
  let deployments = {}
  files.forEach(file => {
    file.deployments.forEach(deployment => {
      const image = deployment.spec.template.spec.containers[0].image
      const ports = deployment.spec.template.spec.containers[0].ports.map(
        port => `${port.containerPort}`
      )
      deployments[deployment.metadata.name] = {
        ports,
        // volumes: [{ '.': '/code' }], // TODO
        image
      }
    })
  })

  // Write out docker compose file
  return {
    version: '2',
    services: deployments
  }
}

function buildKube (files) {
  let configs = []
  files.forEach(file => {
    if (Array.isArray(file.deployments)) {
      configs = configs.concat(file.deployments)
    }
  })
  files.forEach(file => {
    if (Array.isArray(file.services)) {
      configs = configs.concat(file.services)
    }
  })
  return configs
}

function buildAppDeployment (pkg, env, tags, answers) {
  const appName = pkg.name.toLowerCase()
  const name = `${appName}-${env}`

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name
    },
    spec: {
      selector: {
        matchLabels: {
          app: appName,
          env: env
        }
      },
      minReadySeconds: 5,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1,
          maxUnavailable: 0
        }
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            deployedBy: 'deploy-node-app',
            app: appName,
            env: env
          }
        },
        spec: {
          volumes: [],
          // TODO:
          // imagePullSecrets: [
          //   {
          //     name: 'regsecret'
          //   }
          // ],
          containers: [
            {
              name,
              image: tags.env,
              imagePullPolicy: 'Always',
              ports: [
                {
                  name: answers.protocol,
                  containerPort: parseInt(answers.port, 10)
                }
              ],
              // envFrom: [
              //   {
              //     secretRef: {
              //       name: env
              //     }
              //   }
              // ],
              resources: {
                requests: {
                  cpu: '1m',
                  memory: '32Mi'
                },
                limits: {
                  cpu: '100m',
                  memory: '64Mi'
                }
              }
            }
          ]
        }
      }
    }
  }
}

// Assuming nginx container, listening on port 80
function buildUiDeployment (pkg, env, tags, answers) {
  const appName = `${pkg.name.toLowerCase()}-ui`
  const name = `${appName}-${env}`

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name
    },
    spec: {
      selector: {
        matchLabels: {
          app: appName,
          env: env
        }
      },
      minReadySeconds: 5,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1,
          maxUnavailable: 0
        }
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            deployedBy: 'deploy-node-app',
            app: appName,
            env: env
          }
        },
        spec: {
          volumes: [],
          // TODO:
          // imagePullSecrets: [
          //   {
          //     name: 'regsecret'
          //   }
          // ],
          containers: [
            {
              name,
              image: tags.uienv,
              imagePullPolicy: 'Always',
              ports: [
                {
                  name: 'http',
                  containerPort: 80
                }
              ],
              resources: {
                requests: {
                  cpu: '1m',
                  memory: '32Mi'
                },
                limits: {
                  cpu: '100m',
                  memory: '64Mi'
                }
              }
            }
          ]
        }
      }
    }
  }
}

// Currently only useful for KubeSail
function buildAppService (pkg, env, tags, answers, namespace, exposeExternally = true) {
  const appName = pkg.name.toLowerCase()
  const name = `${appName}-${env}-http`

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      annotations: exposeExternally
        ? {
          'getambassador.io/config': JSON.stringify({
            apiVersion: 'ambassador/v1',
            kind: 'Mapping',
            name: `${name}.${namespace}`,
            prefix: '/',
            service: `http://${name}.${namespace}:${answers.port}`,
            host: `${appName}--${namespace}.kubesail.io`, // TODO allow custom domains
            timeout_ms: 10000,
            use_websocket: true
          })
        }
        : null,
      name: `${name}`
    },
    spec: {
      ports: [
        {
          port: answers.port,
          protocol: 'TCP',
          targetPort: answers.port
        }
      ],

      selector: {
        deployedBy: 'deploy-node-app',
        app: appName,
        env: env
      }
    }
  }
}

// Currently only useful for KubeSail
// Assuming nginx container, listening on port 80
function buildUiService (pkg, env, tags, answers, namespace) {
  const appName = `${pkg.name.toLowerCase()}-ui`
  const name = `${appName}-${env}-http`

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      annotations: {
        'getambassador.io/config': JSON.stringify({
          apiVersion: 'ambassador/v1',
          kind: 'Mapping',
          name: `${name}.${namespace}`,
          prefix: '/',
          service: `http://${name}.${namespace}:80`,
          host: `${appName}-www--${namespace}.kubesail.io`, // TODO allow custom domains
          timeout_ms: 10000,
          use_websocket: true
        })
      },
      name: `${name}`
    },
    spec: {
      ports: [
        {
          port: 80,
          protocol: 'TCP',
          targetPort: 80
        }
      ],
      selector: {
        deployedBy: 'deploy-node-app',
        app: appName,
        env: env
      }
    }
  }
}

module.exports = {
  buildDependencyConfig,
  buildAppDeployment,
  buildUiDeployment,
  buildAppService,
  buildUiService
}
