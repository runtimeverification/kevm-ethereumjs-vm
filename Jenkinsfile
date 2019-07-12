pipeline {
  agent {
    dockerfile {
      additionalBuildArgs '--build-arg USER_ID=$(id -u) --build-arg GROUP_ID=$(id -g)'
    }
  }
  options {
    ansiColor('xterm')
  }
  stages {
    stage("Init title") {
      when { changeRequest() }
      steps {
        script {
          currentBuild.displayName = "PR ${env.CHANGE_ID}: ${env.CHANGE_TITLE}"
        }
      }
    }
    stage('Dependencies') {
      steps {
        sh '''
          make deps
        '''
      }
    }
    stage('Build KEVM-VM') {
      steps {
        sh '''
          make build-kevm-node
        '''
      }
    }
    stage('Build Ganache with KEVM-VM') {
      steps {
        sh '''
          make ganache || true
        '''
      }
    }
    stage('Build OpenZeppelin-Solidity') {
      steps {
        sh '''
          make erc20 || true
          cd ./deps/openzeppelin-solidity
          node node_modules/.bin/truffle compile
        '''
      }
    }
    stage('Launch KEVM-VM') {
      steps {
        KEVM_OUTPUT = sh(returnStdout: true, script: './deps/evm-semantics/.build/defn/vm/kevm-vm 8080 127.0.0.1')
      }
    }
    stage('Launch Ganache-CLI') {
      steps {
        CLI_OUTPUT = sh(returnStdout: true, script: 'node ./deps/ganache-cli/cli.js')
      }
    }

    stage('Run Truffle Test') {
      steps {
        sh '''
          cd ./deps/openzeppelin-solidity
          node node_modules/.bin/truffle test test/token/ERC20/ERC20.test.js
          pkill node
          pkill kevm-vm
        '''
      }
    }
    echo "KEVM-VM OUTPUT \n ${KEVM_OUTPUT}"
    echo "GANACHE_CLI OUTPUT \n ${CLI_OUTPUT}"
  }
}
