/**
 * Ethereum Smart Contract Interface - a NodeJS library for compiling, deploying, and interacting with the smart contracts
 * Copyright (C) 2019,  Alexandr V.Mekh
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

const HDWalletProvider = require('truffle-hdwallet-provider');
const EventEmitter = require('events');
const PromiEvent = require('web3-core-promievent');
const Web3js = require('web3');
const Mutex = require('await-semaphore').Mutex;
const net = require('net');
const bn = require('big-integer');
const _ = require('lodash');
const WsProvider = require('./wsProvider');
const utils = require('./utils');
const erc20 = require('./ERC20');
const {
    FixedLengthArray,
    returnValue,
    toChecksum,
    fromWei,
    toWei,
    sleep,
    _to
} = utils;

EventEmitter.defaultMaxListeners = 5000;

let log = new Proxy({}, {
    get: function (logger, logLevel) {
        return function(message) {
            const isDebug = process.env.LOG_LEVEL === 'debug';
            if(!isDebug) return;
            message = `[${(new Date()).toISOString()}] [${logLevel}] ${message}`;
            console.log(message)
        }
    }
});

const setLogger = logger => log = logger;

class Subscription {
    constructor(obj, event, ...args) {
        this.subscription = null;
        this.unsibscribed = false;
        this.target = obj.events;
        this.address = obj.address;
        this.event = event;
        this.args = args;
        this.subscribe()
    }

    unsubscribe () {
        if(!this.subscription) return;
        this.subscription.unsubscribe();
        this.unsibscribed = true;
        this.subscription = null;
    }

    subscribe () {
        if(this.unsibscribed) return;
        this.subscription = this.target[this.event](...this.args);
        log.debug(`[${this.address}]  -> subscribed to ${this.event}`);
    }
}


class TransactionObject {
    constructor (txMeta) {
        const { id } = txMeta;
        if(id && TransactionObject._ids && TransactionObject._ids[id])
            return TransactionObject._ids[id]; // don't create a new instance, return an existing one instead

        if(!TransactionObject._ids) TransactionObject._ids = {};
        Object.keys(txMeta).forEach(key => this[key] = txMeta[key]);

        if(id) TransactionObject._ids[id] = this;
    }
}


class TransactionManager {
    constructor(enforce=false) {
        //return a singleton by default
        if (TransactionManager._instance && !enforce) return TransactionManager._instance;
        this.tx = [];
        this.totalGasUsed = bn.zero;
        this.totalEthSpent = 0;
        this.retries = 0;
        this._lockMap = {};
        this._nonceInUse = {};
        this._idCounter = Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
        TransactionManager._instance = this;
    }

    addTx(txMeta) {
        delete txMeta.txHash;
        delete txMeta.data;

        const { id } = txMeta;

        txMeta.time = txMeta.time || (new Date()).getTime();

        if(id) {
            const txs = this.getFilteredTxList({ id });
            if(txs) this.updateTx(txMeta, 'pending');
            return
        }

        txMeta.id = this._createRandomId();
        this.tx.push(txMeta);
    };

    getFailedTransactions(address) {
        return this._filterTxByStatus(address, 'failed')
    };

    getConfirmedTransactions(address) {
        return this._filterTxByStatus(address, 'confirmed')
    };

    getPendingTransactions(address) {
        return this._filterTxByStatus(address, 'pending')

    };

    getSubmittedTransactions(address) {
        return this._filterTxByStatus(address, 'submitted')
    };

    getFilteredTxList(opts, initialList) {
        let filteredTxList = initialList;
        Object.keys(opts).forEach((key) => {
            filteredTxList = this.getTxsByMetaData(key, opts[key], filteredTxList)
        });
        return filteredTxList
    };

    getTxsByMetaData(key, value, txList = this.tx) {
        return txList.filter(txMeta => txMeta[key] === value)
    };

    updateTx(txMeta, status) {
        txMeta.status = status;
        txMeta.lastUpdate = (new Date()).getTime();
        txMeta.duration = (txMeta.lastUpdate - txMeta.time)/1000;
        const index = this.tx.findIndex(tx => tx.id === txMeta.id);
        log.debug(`updateTx[${index}]: ${JSON.stringify(txMeta)}`);
        Object.keys(txMeta).forEach(key => {this.tx[index][key] = txMeta[key]});
    };

    async getTxMeta(...methodArgs) {
        const obj = methodArgs.shift();
        const method = methodArgs.shift();

        const lastArg = methodArgs[methodArgs.length - 1];
        const lastArgType = typeof lastArg;
        const isObject = (lastArgType === 'function' || lastArgType === 'object' && !!lastArg) && !Array.isArray(lastArg);

        const options = isObject ? methodArgs.pop() : {};
        if(!obj.accounts || !obj.accounts.length) await obj.init();

        options.from = options.from || obj.wallet;
        let txType = 'call';

        if(!obj._call.includes(method)) {
            txType = 'send';
            options.gas = options.gas || obj.gasLimit;
            options.gasPrice = options.gasPrice || obj.gasPrice;
            const blockGasPrice = await obj.getGasPrice();

            if(!options.gasPrice) options.gasPrice = Math.ceil(blockGasPrice * 1.2);
            const { gasPrice } = options;

            if(gasPrice < blockGasPrice || gasPrice > blockGasPrice * 10)
                log.warn(`the gas price is too ${blockGasPrice > gasPrice ? "LOW" : "HIGH"}: `+
                         `blockchain - ${fromWei(blockGasPrice, 'gwei')}, ` +
                         `TxObject - ${fromWei(gasPrice, 'gwei')} (GWEI)`)
        }

        return new TransactionObject({
            id: options.txId,
            from: options.from,
            to: obj.address,
            method,
            methodArgs,
            options,
            txType
        });
    };

    async getNonce(address, w3) {
        address = toChecksum(address);
        const releaseNonceLock = await this._getLock(address);
        try {
            const block = await w3.eth.getBlock('latest');
            const nextNetworkNonce = await w3.eth.getTransactionCount(address, block.number);
            const highestLocallyConfirmed = this._getHighestLocallyConfirmed(address);

            const highestSuggested = Math.max(nextNetworkNonce, highestLocallyConfirmed);

            const submittedTxs = this.getSubmittedTransactions(address);
            const pendingTxs = this.getPendingTransactions(address).filter(tx => tx.nonce > 0);

            const localNonceResult = this._getHighestContinuousFrom(
                submittedTxs.concat(pendingTxs),
                highestSuggested,
                address) || 0;

            const highestPending = pendingTxs.length ?
                pendingTxs.map(tx => tx.nonce).reduce((a, b) => Math.max(a, b)) :
                0;

            const nonceDetails = {
                localNonceResult,
                highestLocallyConfirmed,
                highestSuggested,
                nextNetworkNonce,
                highestPending
            };

            const nextNonce = Math.max(nextNetworkNonce, localNonceResult);

            return { nextNonce, nonceDetails, releaseNonceLock };

        } catch (err) {
            log.error(`getNonce error: ${err}`);
            releaseNonceLock();
            throw err
        }
    };

    async submitTx(obj, txMeta, defer, path) {
        const exec = _.get(obj, path || 'contract.methods');

        const { method, methodArgs, options, txType } = txMeta;

        if(txType === 'call') return await _to(exec[method](...methodArgs).call(options));

        this.addTx(txMeta);

        const { nextNonce, nonceDetails, releaseNonceLock } = await this.getNonce(options.from, obj.w3);

        await this._waitQueue();

        options.nonce = options.nonce || nextNonce;
        txMeta.nonce = options.nonce;
        this.updateTx(txMeta, 'submitted');

        releaseNonceLock();

        log.debug(JSON.stringify({ id: txMeta.id, nonceDetails }));

        const [err, result] = await _to(exec[method](...methodArgs)
            .send(options)
            .on('transactionHash', hash => {
                defer.eventEmitter.emit('transactionHash', hash);
                log.debug(`transactionHash: ${txMeta.id} -> ${hash}`);
                txMeta.txHash = hash
            })
            .on('receipt', receipt => {
                defer.eventEmitter.emit('receipt', receipt);
                txMeta.blockNumber = receipt.blockNumber;
                this._calculateGasExpenses(obj, txMeta, receipt.gasUsed);
            })
            .on('error', e => {
                defer.eventEmitter.emit('error', e);
                this._checkError(e, options.from, txMeta);
            }));

        if(!err && method === 'deploy' && path === 'contract')  obj.at(result.options.address);

        this._finalizeTx(txMeta, err);

        return [err, result]
    };

    getTxStat (id) {
        let data = id ? { id } : {};

        return Object.assign(
            data, {
                submitted: this.getSubmittedTransactions().length,
                pending: this.getPendingTransactions().length,
                failed: this.getFailedTransactions().length,
                confirmed: this.getConfirmedTransactions().length,
                retries: this.retries,
                totalGasUsed: this.totalGasUsed.toString(),
                totalEthSpent: this.totalEthSpent.toString()
            })
    };

    updateStat(gasUsed, gasPrice) {
        const weiSpent =  bn(gasUsed).multiply(bn(gasPrice)).toString();
        this.totalGasUsed = this.totalGasUsed.add(bn(gasUsed));
        this.totalEthSpent = this.totalEthSpent + parseFloat(fromWei(weiSpent));
    };

    _calculateGasExpenses(obj, txMeta, gasUsed = 0) {
        obj.gasUsed = gasUsed;
        obj.totalGasUsed = bn(obj.totalGasUsed).add(bn(gasUsed)).toString();

        txMeta.gasUsed = gasUsed;
        txMeta.totalGasUsed = obj.totalGasUsed;

        this.updateStat(gasUsed, txMeta.options.gasPrice);
    }

    _finalizeTx(txMeta, err) {
        const {id, txHash} = txMeta;

        let status = err ? 'failed' : 'confirmed';
        this.updateTx(txMeta, status);

        status = `submitTx: ${status.toUpperCase()} - ${id}`;

        if(!err) log.debug(status);
        else {
            if(err.message && err.message.includes('Transaction ran out of gas')) {
                const gasPrice = fromWei(txMeta.options.gasPrice, 'gwei');
                log.warn(`${status} (${txHash}), the transaction has been reverted or the gasLimit is too low (${gasPrice} gwei)`);
            }
            else log.error(`${status}, ${err}`);
        }

        const stat = this.getTxStat('submitTxOUT');
        const message = JSON.stringify({...stat, txId: id, txHash});

        log[err ? 'warn' : 'debug'](message);
    }

    _checkError (err, address, txMeta) {
        address = toChecksum(address);
        const { message } = err;
        const { id, nonce } = txMeta;
        if (
            message.includes('nonce too low') ||
            message.includes('Transaction was not mined within') ||
            message.includes('known transaction') ||
            message.includes('replacement transaction underpriced')
        ) {
            if(!(address in this._nonceInUse)) {
                this._nonceInUse[address] = new FixedLengthArray(200, true);
            }
            log.warn(`nonce in use: ${address}, ${id}, ${nonce} -> ${this._listToPeriods(this._nonceInUse[address])}`);
            this._nonceInUse[address].push(nonce);
        }
    };

    _listToPeriods (arr) {
        arr.sort((a,b) => a-b);

        let r = [[arr[0]]];
        let idx = 0;
        for(let i=1; i<arr.length; i++) {
            const isNext = arr[i] - arr[i-1] === 1;
            if( isNext) continue;

            if (r[idx][0] !== arr[i - 1]) r[idx].push(arr[i - 1]);
            idx++;
            r.push([arr[i]]);
        }

        const rl = r.length;
        if(r[rl - 1].length === 1 && arr.slice(-1)[0] !== r[rl - 1][0])
            r[rl - 1].push(arr.slice(-1)[0]);

        let res = [];
        r.forEach((item) => {
            res.push(item.join(' - '))
        });

        return res.join(', ');
    };

    _filterTxByStatus(address, status) {
        const filter = { status };
        if(address) filter.from  = address;
        return this.getFilteredTxList(filter)
    }

    _getHighestLocallyConfirmed (address) {
        const confirmedTransactions = this.getConfirmedTransactions(address);
        const highest = this._getHighestNonce(confirmedTransactions);
        return Number.isInteger(highest) ? highest + 1 : 0
    };

    _getHighestContinuousFrom (txList, startPoint, address) {
        if(address) address = toChecksum(address);

        const nonces = txList.map(txMeta => txMeta.nonce);
        const inUse = this._nonceInUse[address];

        let highest = startPoint;
        while (nonces.includes(highest) || (address && inUse && inUse.includes(highest))) {
            highest++
        }
        return highest
    };

    _getHighestNonce (txList) {
        const nonces = txList.map(txMeta => txMeta.nonce);
        return nonces.length ? nonces.reduce((a, b) => Math.max(a, b)) : null
    };

    async _waitQueue() {
        let awaiting = this.getSubmittedTransactions().length;
        let pending = this.getPendingTransactions().length;

        const awaitLimit = 100;
        const awaitTime = 60; //seconds

        if(awaiting >= awaitLimit) {
            while(awaiting >= awaitLimit) {
                log.debug(`Too many transactions are waiting to be mined: submitted ` +
                          `- ${awaiting}, pending - ${pending}, sleeping ${awaitTime} seconds...`);
                await sleep(awaitTime * 1000);
                awaiting = this.getSubmittedTransactions().length;
                pending = this.getPendingTransactions().length;
            }
        }
    }

    async _getLock (address) {
        const mutex = this._lookupMutex(address);
        return mutex.acquire()
    };

    _lookupMutex (lockId) {
        let mutex = this._lockMap[lockId];
        if (!mutex) {
            mutex = new Mutex();
            this._lockMap[lockId] = mutex
        }
        return mutex;
    };

    _createRandomId() {
        this._idCounter = this._idCounter % Number.MAX_SAFE_INTEGER;
        return this._idCounter++
    }
}


const proxyHandler = {
    get: function ptoxyGet (obj, prop) {
        if(!obj.proxyMethods.includes(prop)) return obj[prop];
        if(prop in obj) return obj[prop];

        let isEvent = obj._events.includes(prop);

        if(isEvent) {
            const event = prop.split(/^on/)[1];
            obj[prop] = function proxyAddEvent (...args) {
                let options = {};
                const callback = args[args.length - 1];
                if(_.isPlainObject(args[0])) options = args[0];
                return obj._subscribe(options, event, callback);
            };

            return obj[prop];
        }

        obj[prop] = function proxyAddProp (...args) {
            let path = 'contract.methods';
            const defer = PromiEvent();

            const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
            if(callback) args.pop();

            let retryOptions = args.filter(item => item.retryOptions)[0];
            if(retryOptions) {
                const idx = args.indexOf(retryOptions);
                retryOptions = args.splice(idx, 1)[0].retryOptions;
            }

            if(prop === '_deploy') {
                path = 'contract';
                prop = 'deploy'
            }

            const send = (meta) => {
                if(!retryOptions) {
                    obj.txManager.submitTx(obj, meta, defer, path).then(([err, res]) => {
                        returnValue(err, res, defer, callback);
                    })
                } else {
                    obj.sendWithRetry(meta, retryOptions, defer).then(([err, res]) => {
                        returnValue(err, res, defer, callback)
                    })
                }
            };

            obj.txManager.getTxMeta(obj, prop, ...args).then(send);
            return defer.eventEmitter;
        };

        return obj[prop]
    }
};

class Web3 {
    constructor (nodeAddress, mnemonic) {
        if (!nodeAddress)
            throw "Error: the node address is not defined!";

        const supportedProtocols = ['ws', 'wss', 'http', 'https', 'ipc'];
        let protocol;
        if (nodeAddress.search(/\.ipc$/) !== -1) protocol = 'ipc';
        else protocol = nodeAddress.split(':')[0];

        if (!supportedProtocols.includes(protocol))
            throw new Error(`"${protocol}" protocol is not supported! ` +
            `Supported protocols:\n${JSON.stringify(supportedProtocols)}`);

        let provider;
        let emitter = new EventEmitter;

        if(protocol === 'ipc') {
            provider = new Web3js.providers.IpcProvider(nodeAddress, net);

        } else if (protocol.startsWith('ws')) {
            const _ws = new WsProvider(nodeAddress);
            provider = _ws.provider;
            provider.on('connect', () => log.info(`WebSocket - connected to "${nodeAddress}"`));
            emitter = _ws.emitter;

        } else {
            provider = new Web3js.providers.HttpProvider(nodeAddress);
        }

        if (mnemonic) {
            let addressesToUnlock = 20;

            if (mnemonic.indexOf(" ") === -1 || Array.isArray(mnemonic)) {
                const privateKeys = Array.isArray(mnemonic) ? mnemonic : [mnemonic];
                addressesToUnlock = privateKeys.length;
            }

            provider = new HDWalletProvider(mnemonic, provider, 0, addressesToUnlock);
            provider.engine.stop(); // stop block-polling
        }

        this.provider = provider;
        this.emitter = emitter;
        this.web3 = new Web3js(provider);
    }
}


class Interface {
    constructor (nodeAddress, contractAddress, mnemonic, web3Instance, abi, bytecode) {
        if (web3Instance) {
            this.w3 = web3Instance;
        } else {
            if (!nodeAddress)
                throw "The node address is not defined!";

            this.protocol = nodeAddress.split(':')[0];
            const _web3 = new Web3(nodeAddress, mnemonic);
            this.w3 = _web3.web3;
            this.emitter = _web3.emitter;
            this.emitter.on('resetProvider', provider => this._resetProvider(provider));
        }

        this.contract = new this.w3.eth.Contract(abi);
        this.methods = this.contract.methods;
        this.events = this.contract.events;
        this.subscriptions = [];

        if(contractAddress) {
            this._address = toChecksum(contractAddress);
            this.at(this._address);
        }

        this.abi = abi;
        this._gasPrice = null;
        this.bytecode = bytecode;
        this.gasLimit = '6000000';
        this.gasUsed = 0;
        this.totalGasUsed = 0;
        this.accounts = this.w3.currentProvider.addresses || [];
        this.walletIndex = 0;

        this._setProxyMethods();

        this.txManager = new TransactionManager();

        return new Proxy(this, proxyHandler);
    }

    _resetProvider(provider) {
        this.contract.setProvider(provider);
        this.subscriptions.forEach(sub => {
            if(!sub.unsibscribed)
                log.debug(`[${this.address}] Restoring the "${sub.event}" subscription...`);
            sub.subscribe()
        });
    }

    _subscribe(options, event, callback) {
        if(!callback || typeof callback !== 'function')
            throw new Error('Callback must be a function!');

        const subscription = new Subscription(this, event, options, callback);
        this.subscriptions.push(subscription);
        return subscription;
    }

    _setProxyMethods() {
        const _callStates = ['pure', 'view'];
        this._sent = this.abi.filter(item => !_callStates.includes(item.stateMutability) && item.type === 'function').map(item => item.name);
        this._call = this.abi.filter(item => _callStates.includes(item.stateMutability) && item.type === 'function').map(item => item.name);
        this._events = this.abi.filter(item => item.type === 'event').map(item => 'on' + item.name);
        this.proxyMethods = this._sent.concat(['_deploy']).concat(this._call).concat(this._events);
    }

    static web3 (web3Instance, contractAddress, abi, bytecode) {
        return new Interface(null, contractAddress, null, web3Instance, abi, bytecode)
    }

    get wallet() {
        if (this.accounts && this.accounts.length)
            return toChecksum(this.accounts[this.walletIndex])
    }

    set wallet(index) {
        this.walletIndex = index;
    }

    set gasPrice(price) {
        if(!price || Number(parseFloat(price)) !== price)
            this._gasPrice = null;
        else
            this._gasPrice = toWei(price, 'gwei');
    }

    get gasPrice() {
        return this._gasPrice;
    }

    get address() {
        return this._address;
    }

    set address(address) {
        this.at(address)
    }

    get abi() {
        return this.contract.options.jsonInterface;
    }

    set abi(abi) {
        this.contract.options.jsonInterface = abi;
        this._setProxyMethods();
    }

    at(address) {
        this._address = address;
        this.contract.options.address = toChecksum(address);
        return this;
    }

    async init() {
        if (!this.accounts || !this.accounts.length) this.accounts = await this.w3.eth.getAccounts();
    }

    async getGasPrice(multiplier) {
        multiplier = multiplier || 1;
        const gasPrice = await this.w3.eth.getGasPrice();
        return Math.ceil(gasPrice * multiplier);
    }

    deploy(options, callback) {
        options = options || {};

        const {from, gas, gasPrice, gasLimit, nonce, value, args, bytecode} = options;

        const _args = [
            {data: bytecode || this.bytecode, arguments: args || []},
            {from, gas, gasPrice, gasLimit, nonce, value}
        ];

        if (callback) _args.push(callback);

        return this._deploy(..._args);
    };

    async sendWithRetry (txMeta, retryOptions, defer) {
        let err, result, counter = 0;
        retryOptions = retryOptions || {};

        const { methodArgs } = txMeta;
        const { txManager } = this;

        let delay = retryOptions.delay || 10; //seconds
        let gasPrice = retryOptions.gasPrice || this.gasPrice || await this.getGasPrice(1.2); //block gasPrice + 20%
        const verify = retryOptions.verify || function () {};
        const retry = retryOptions.retry || 3;
        const incBase = retryOptions.incBase || 1;

        const updateNonce = (e, n) => e.includes('Transaction was not mined within') ? n : null;

        const pre = (meta, counter) => `[try #${counter}] [txId ${meta.id}] [txHash ${meta.txHash}]`;

        const updateTx = (meta, result, err, counter) => {
            const { id, txHash, status } = meta;
            if(status === 'confirmed') return [null, result];

            log.debug(pre(meta, counter) + ` -> Tx Success${err ? ", VERIFIED" : ""}`);
            txManager.updateTx(meta, 'confirmed');

            log.debug(JSON.stringify({...txManager.getTxStat(`try #${counter} out`), txId: id, txHash }));
            return [null, result]
        };

        const _verify = async (err, args) => err ? !!(await verify(...args)) : true;

        const _sleep = (meta, counter, delay) => {
            log.warn(pre(meta, counter) + ` - Tx Failed, next try in ${delay * (counter + 1)} seconds...`);
            return sleep(delay * (counter + 1) * 1000);
        };

        do {
            txMeta.options.gasPrice = Math.ceil(+gasPrice * incBase ** counter);

            [err, result] = await txManager.submitTx(this, txMeta, defer);
            delete txMeta.options.data;

            if(await _verify(err, methodArgs)) return updateTx(txMeta, result, err, counter);
            if(retry === counter) break;

            await _sleep(txMeta, counter, delay);
            if(await _verify(err, methodArgs)) return updateTx(txMeta, result, err, counter);

            txMeta.options.nonce = updateNonce(err.message, txMeta.nonce);

            log.debug(`resubmit: ${txMeta.id} -> ${JSON.stringify(txMeta)}`);
            txManager.retries++;
            counter++;
        } while (counter <= retry);

        log.error(pre(txMeta, counter) + ` - Tx Failed`);
        return [err, result]
    };
}


class ERC20 extends Interface {
    constructor(nodeAddress, tokenAddress, mnemonic, web3Instance, abi, bytecode) {
        abi = abi || erc20;
        super(nodeAddress, tokenAddress, mnemonic, web3Instance, abi, bytecode);
    }
}


module.exports = {
    Interface,
    ERC20,
    Web3,
    setLogger,
    utils
};
