const Buffer = require('safe-buffer').Buffer
const async = require('async')
const ethUtil = require('ethereumjs-util')
const BN = ethUtil.BN
const { StorageReader } = require('./state')
const Memory = require('./evm/memory')
const Stack = require('./evm/stack')
const ERROR = require('./exceptions')
const net = require('net')
const msgPb = require('./proto/msg_pb.js')

const QUERY_NOT_SET = 0
const GETACCOUNT = 1
const GETSTORAGEDATA = 2
const GETCODE = 3
const GETBLOCKHASH = 4
const CALLRESULT = 5

/**
 * runs a CALL operation
 * @method vm.runCall
 * @private
 * @param opts
 * @param opts.block {Block}
 * @param opts.caller {Buffer}
 * @param opts.code {Buffer} this is for CALLCODE where the code to load is different than the code from the to account.
 * @param opts.data {Buffer}
 * @param opts.gasLimit {Buffer | BN.js }
 * @param opts.gasPrice {Buffer}
 * @param opts.origin {Buffer} []
 * @param opts.to {Buffer}
 * @param opts.value {Buffer}
 * @param {Function} cb the callback
 */
module.exports = function (opts, cb) {
  var self = this
  var stateManager = self.stateManager
  // TODO: remove commented variables on release if we end up not needing them.
  var vmResults = {}
  // var toAccount
  var toAddress = opts.to
  var createdAddress
  var txValue = opts.value || Buffer.from([0])
  var caller = opts.caller
  // var account
  var block = opts.block
  var code = opts.code
  var txData = opts.data
  var gasLimit = opts.gasLimit || new BN(0xffffff)
  gasLimit = ensurePositive(new BN(opts.gasLimit).toBuffer('be')) // make sure is a Buffer
  var gasPrice = opts.gasPrice
  // var gasUsed = new BN(0)
  // var origin = opts.origin
  // var isCompiled = opts.compiled
  var depth = opts.depth
  // opts.suicides is kept for backward compatiblity with pre-EIP6 syntax
  var selfdestruct = opts.selfdestruct || opts.suicides
  // var delegatecall = opts.delegatecall || false
  // var isStatic = opts.static || false
  // var salt = opts.salt || null
  var storageReader = opts.storageReader || new StorageReader(stateManager)
  var results = {}
  var client = new net.Socket()
  const kevmHost = '127.0.0.1'
  const kevmPort = 8080
  var datapiece = null
  var logList = []

  async.series([checkpointState, runClient], commitState)

  function checkpointState (_callback) {
    stateManager.checkpoint(_callback)
  }

  function debug (data) {
    if (process.env.FIREFLY_DEBUG) {
      console.log(data)
    }
  }

  function runClient (_callback) {
    // Add a 'data' event handler for the client socket
    // data is what the server sent to this socket
    client.on('data', function (data) {
      if (datapiece != null) {
        data = Buffer.concat([datapiece, data])
        datapiece = null
      }

      if (data.readInt32BE() > data.slice(4).length) {
        // The message is too short, not ready to process yet
        datapiece = data
        return
      }

      var query = msgPb.VMQuery.deserializeBinary(data.slice(4))

      switch (query.getQueryCase()) {
        case GETACCOUNT: {
          debug('GETACCOUNT')
          computeGetAccount(query, function (fromAccount) {
            var message = createAccount(fromAccount)
            client.write(message)
          })
          break
        }
        case GETSTORAGEDATA: {
          debug('GETSTORAGEDATA')
          computeGetStorageData(query, function (value) {
            var message = createStorageData(value.current)
            client.write(message)
          })
          break
        }
        case GETCODE: {
          debug('GETCODE')
          computeGetCode(query, function (contractCode, compiled) {
            // TODO: This does not seem to be used anywhere. Remove on release if we end up not needing it.
            // isCompiled = compiled
            code = contractCode
            var message = createCode(code)
            client.write(message)
          })
          break
        }
        case GETBLOCKHASH: {
          debug('GETBLOCKHASH')
          computeGetBlockHash(query, function (hash) {
            var message = createBlockhash(hash)
            client.write(message)
          })
          break
        }
        case CALLRESULT: {
          debug('CALLRESULT')
          client.end()
          computeCallResult(query, _callback)
          break
        }
        case QUERY_NOT_SET: {
          debug('QUERYNOTSET')
          break
        }
      }
    })

    // Add a 'close' event handler for the client socket
    client.on('close', function () {
      debug('Connection closed')
    })

    client.connect(kevmPort, kevmHost, function () {
      debug('CONNECTED TO: ' + kevmHost + ':' + kevmPort)
      var hello = createHello()
      client.write(hello)
      var message = createCallContext()
      client.write(message)
    })
  }

  function computeCallResult (query, _callback) {
    var gasProvided = new BN(gasLimit)

    var callResultObject = query.getCallresult()
    var rawReturnData = Buffer.from(callResultObject.getReturndata())
    var returnData = rawReturnData.length ? ethUtil.bufferToHex(rawReturnData) : rawReturnData
    var returnCode = callResultObject.getReturncode()
    var gasRemaining = new BN(callResultObject.getGasremaining())
    var gasRefund = new BN(callResultObject.getGasrefund())
    var error = callResultObject.getError()
    var modifiedAccounts = callResultObject.getModifiedaccountsList()
    var logEntries = callResultObject.getLogsList()
    var statusCode = Buffer.from(callResultObject.getStatuscode()).toString()
    var logs = fromLogEntries(logEntries)
    if (typeof toAddress === 'undefined') {
      var returnCodeBuffer = Buffer.from(returnCode)
      while (returnCodeBuffer.length < 20) {
        returnCodeBuffer = Buffer.concat([Buffer.from([0]), returnCodeBuffer])
      }
      while (returnCodeBuffer.length > 20) {
        returnCodeBuffer = returnCodeBuffer.slice(1)
      }
      createdAddress = ethUtil.bufferToHex(returnCodeBuffer)
    }
    updateAccounts(modifiedAccounts, () => {
      var runState = {
        blockchain: self.blockchain,
        stateManager: stateManager,
        storageReader: storageReader,
        returnValue: error ? rawReturnData : returnData,
        stopped: false,
        vmError: false,
        programCounter: opts.pc | 0,
        opCode: undefined,
        opName: undefined,
        gasLeft: gasRemaining,
        gasLimit: gasLimit,
        gasPrice: gasPrice,
        memory: new Memory(),
        memoryWordCount: new BN(0),
        stack: new Stack(),
        lastReturned: [],
        logs: logs,
        validJumps: [],
        gasRefund: gasRefund,
        highestMemCost: new BN(0),
        depth: depth,
        selfdestruct: selfdestruct,
        block: block,
        callValue: opts.value || new BN(0),
        address: opts.address || ethUtil.zeros(32),
        caller: caller,
        origin: opts.origin || opts.caller || ethUtil.zeros(32),
        callData: opts.data || Buffer.from([0]),
        code: code,
        static: opts.static || false
      }

      vmResults = {
        runState: runState,
        selfdestruct: runState.selfdestruct,
        gasRefund: runState.gasRefund,
        exception: error ? 0 : 1,
        exceptionError: error ? ERROR.getExceptionType(statusCode) : '',
        logs: runState.logs,
        gas: runState.gasLeft,
        'return': runState.returnValue ? runState.returnValue : Buffer.alloc(0)
      }

      results = {
        gasUsed: gasProvided.sub(gasRemaining),
        createdAddress: createdAddress,
        vm: vmResults
      }
      _callback()
    })
  }

  function updateAccounts (accountList, _callback) {
    async.series(
      accountList.map(account => function (_itemCallback) {
        updateAccount(account, _itemCallback)
      })
      , _callback
    )
  }

  function commitState () {
    stateManager.commit(function () {
      debug('commit done')
      cb(null, results)
    })
  }

  function updateAccount (pbAccount, _done) {
    var address = Buffer.from(pbAccount.getAddress())
    var nonce = Buffer.from(pbAccount.getNonce())
    var newBalance = Buffer.from(pbAccount.getBalance())
    var code = Buffer.from(pbAccount.getCode())
    var storageUpdateList = pbAccount.getStorageupdatesList()

    async.series(
      [function (_callback) {
        stateManager.getAccount(address, function (err, stateAccount) {
          if (err) {
            console.log(err)
          }
          stateAccount.nonce = Buffer.from(nonce)
          stateAccount.balance = Buffer.from(newBalance)
          stateManager.putAccount(address, stateAccount, _callback)
        })
      },
      function (_callback) {
        if (code.length !== 0) {
          stateManager.putContractCode(address, code, _callback)
        } else {
          _callback()
        }
      },
      function (_callback) {
        async.series(
          storageUpdateList.map(item => putContractHelper(address, item)),
          _callback
        )
      }], _done)
  }

  function putContractHelper (address, item) {
    return function (_callback) {
      var key = Buffer.from(item.getOffset())
      if (key.length > 32) {
        debug('KEVM-VM returned a key with a length longer than 32 bytes:', key)
      }
      var value = Buffer.from(item.getData())
      // Remove any zeroes prepended by KEVM
      key = ethUtil.setLengthLeft(chopZeroes(key), 32)
      value = chopZeroes(value)
      debug('Setting contract storage for address: ' + ethUtil.bufferToHex(address) + ' at key: ' + ethUtil.bufferToHex(key) + ' with value: ' + ethUtil.bufferToHex(value))
      stateManager.putContractStorage(address, key, value, _callback)
    }
  }

  function fromLogEntries (logEntries) {
    logList = []
    for (var i = 0; i < logEntries.length; i++) {
      var logEntry = logEntries[i]
      var log = []
      log.length = 3
      log[0] = Buffer.from(logEntry.getAddress())
      log[1] = []
      logEntry.getTopicsList().forEach(element => log[1].push(Buffer.from(element)))
      log[2] = Buffer.from(logEntry.getData())
      logList.push(log)
    }
    return logList
  }

  function computeGetCode (query, _callback) {
    var getCodeObject = query.getGetcode()
    var address = getCodeObject.getAddress()
    stateManager.getContractCode(Buffer.from(address), function (err, contractCode, compiled) {
      if (err) {
        console.log(err)
      }
      _callback(contractCode, compiled)
    })
  }

  function computeGetBlockHash (query, _callback) {
    var getHashObject = query.getGetblockhash()
    var hash

    var offset = getHashObject.getOffset()
    if (offset > 256 || offset < 0) {
      hash = (new BN(0)).toBuffer('le', 256)
      _callback(hash)
    } else {
      self.blockchain.getBlock(offset, function (err, block) {
        if (err) {
          hash = (new BN(0)).toBuffer('le', 256)
        } else {
          hash = block.hash()
        }
        _callback(hash)
      })
    }
  }

  function computeGetStorageData (query, _callback) {
    var getStorageDataObject = query.getGetstoragedata()
    var address = Buffer.from(getStorageDataObject.getAddress())
    var offset = Buffer.from(getStorageDataObject.getOffset())
    if (offset.length > 32) {
      debug('KEVM-VM returned a key with a length longer than 32 bytes:', offset)
    }
    // Remove any zeroes prepended by KEVM
    offset = ethUtil.setLengthLeft(chopZeroes(offset), 32)
    storageReader.getContractStorage(address, offset, function (err, value) {
      if (err) {
        console.log(err)
      }
      _callback(value)
    })
  }

  function computeGetAccount (query, _callback) {
    var getAccountObject = query.getGetaccount()
    var address = getAccountObject.getAddress()
    stateManager.getAccount(Buffer.from(address), function (err, fromAccount) {
      if (err) {
        console.log(err)
      }
      _callback(fromAccount)
    })
  }

  function createCode (code) {
    var codeObject = new msgPb.Code()
    codeObject.setCode(code)
    var bytes = codeObject.serializeBinary()
    var buffer = createBufferFromBytes(bytes)
    return buffer
  }

  function createBlockhash (hash) {
    var blockhashObject = new msgPb.Blockhash()
    blockhashObject.setHash(hash)
    var bytes = blockhashObject.serializeBinary()
    return createBufferFromBytes(bytes)
  }

  function createStorageData (data) {
    var storageData = new msgPb.StorageData()
    storageData.setData(ensurePositive(data))
    var bytes = storageData.serializeBinary()
    var buffer = createBufferFromBytes(bytes)
    return buffer
  }

  function createAccount (fromAccount) {
    var account = new msgPb.Account()
    if (!fromAccount.isEmpty()) {
      account.setNonce(fromAccount.nonce)
      account.setBalance(fromAccount.balance)
    } else {
      debug('Account is empty!')
      account.setNonce(new Uint8Array(1))
      account.setBalance(new Uint8Array(1))
    }
    var isCodeEmpty = fromAccount.codeHash.compare(ethUtil.KECCAK256_NULL) === 0
    account.setCodeempty(isCodeEmpty)
    account.setCodehash(fromAccount.codeHash)
    var bytes = account.serializeBinary()
    var buffer = createBufferFromBytes(bytes)
    return buffer
  }

  function createHello () {
    var hello = new msgPb.Hello()
    hello.setVersion('2.1')
    var bytes = hello.serializeBinary()
    var buffer = createBufferFromBytes(bytes)
    return buffer
  }

  function createCallContext () {
    var callCtx = new msgPb.CallContext()
    var blockHeader = createBlockHeader()
    var ethereumConfig = createEthereumConfig()
    callCtx.setCalleraddr(caller)
    if (typeof toAddress !== 'undefined') {
      callCtx.setRecipientaddr(toAddress)
    }
    callCtx.setInputdata(txData)
    callCtx.setCallvalue(new Uint8Array(ensurePositive(Buffer.from(txValue))))
    callCtx.setGasprice(gasPrice)
    callCtx.setGasprovided(new Uint8Array(gasLimit))
    callCtx.setBlockheader(blockHeader)
    callCtx.setEthereumconfig(ethereumConfig)
    var bytes = callCtx.serializeBinary()
    var buffer = createBufferFromBytes(bytes)
    return buffer
  }

  function createBlockHeader () {
    var hexTimestamp = block.header.timestamp.toString('hex')
    var timestamp = parseInt(hexTimestamp, 16)

    var blockHeader = new msgPb.BlockHeader()
    blockHeader.setBeneficiary(block.header.coinbase)
    blockHeader.setDifficulty(block.header.difficulty)
    blockHeader.setNumber(block.header.number)
    blockHeader.setGaslimit(block.header.gasLimit)
    blockHeader.setUnixtimestamp(timestamp)
    return blockHeader
  }

  function createEthereumConfig () {
    var ethereumConfig = new msgPb.EthereumConfig()
    ethereumConfig.setMaxcodesize(new Uint8Array([96, 0]))
    ethereumConfig.setAccountstartnonce(new Uint8Array([0]))
    ethereumConfig.setFrontierblocknumber(new Uint8Array([0]))
    ethereumConfig.setHomesteadblocknumber(new Uint8Array([0]))
    ethereumConfig.setEip150blocknumber(new Uint8Array([0]))
    ethereumConfig.setEip160blocknumber(new Uint8Array([0]))
    ethereumConfig.setEip161blocknumber(new Uint8Array([0]))
    ethereumConfig.setByzantiumblocknumber(new Uint8Array([0]))
    var hardfork = stateManager._common._hardfork
    switch (hardfork) {
      case 'byzantium': {
        ethereumConfig.setConstantinopleblocknumber(new Uint8Array([127, 255, 255, 255]))
        ethereumConfig.setPetersburgblocknumber(new Uint8Array([127, 255, 255, 255]))
        break
      }
      case 'constantinople': {
        ethereumConfig.setConstantinopleblocknumber(new Uint8Array([0]))
        ethereumConfig.setPetersburgblocknumber(new Uint8Array([127, 255, 255, 255]))
        break
      }
      default : {
        ethereumConfig.setConstantinopleblocknumber(new Uint8Array([0]))
        ethereumConfig.setPetersburgblocknumber(new Uint8Array([0]))
      }
    }
    return ethereumConfig
  }

  function createBufferFromBytes (bytes) {
    var messageLength = new BN(bytes.length)
    var bufferLength = bytes.length + 4
    var result = new Uint8Array(bufferLength)
    var lengthInBytes = messageLength.toArrayLike(Uint8Array, 'be', 4)
    for (var i = 0; i < 4; i++) {
      result[i] = lengthInBytes[i]
    }
    for (i = 0; i < bytes.length; i++) {
      result[i + 4] = bytes[i]
    }
    return Buffer.from(result)
  }

  function chopZeroes (buffer) {
    // Removes leading zeroes in a buffer, for handling values sent by KEVM
    while (buffer[0] === 0 && buffer.length > 1) {
      buffer = buffer.slice(1)
    }
    return buffer
  }

  function ensurePositive (buffer) {
    // Keeps the number represented by a buffer positive in two's complement
    // For sending values to KEVM
    if (buffer[0] >= 0x80) {
      buffer = Buffer.concat([Buffer.from([0]), buffer])
    }
    return buffer
  }
}
