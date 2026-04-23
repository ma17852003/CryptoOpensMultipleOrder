import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as ccxt from 'ccxt';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const LOG_FILE = path.join(__dirname, '../trade.log');

function logAction(message: string) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(LOG_FILE, logMessage);
}

function getExchange(apiKey: string, secret: string) {
  return new (ccxt as any).mexc({
    apiKey,
    secret,
    options: { 
      defaultType: 'swap',
      recvWindow: 10000,
      adjustForTimeDifference: true
    }
  });
}

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveConfig(config: any) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

app.post('/api/connect', async (req, res) => {
  const { apiKey, secret } = req.body;
  try {
    const exchange = getExchange(apiKey, secret);
    const balance = await exchange.fetchBalance();
    res.json({ success: true, balance: balance.total.USDT || 0 });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, config: loadConfig() });
});

app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  res.json({ success: true });
});

app.get('/api/balance', async (req, res) => {
  const { apiKey, secret } = req.query;
  try {
    const exchange = getExchange(apiKey as string, secret as string);
    const balance = await exchange.fetchBalance();
    res.json({ success: true, balance: balance.total.USDT || 0 });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/markets', async (req, res) => {
  const { apiKey, secret } = req.query;
  try {
    const exchange = getExchange(apiKey as string, secret as string);
    const markets = await exchange.loadMarkets();
    const marketData: any = {};
    for (const symbol in markets) {
      const market = markets[symbol];
      const baseSymbol = symbol.split('/')[0];
      marketData[baseSymbol] = {
        symbol: baseSymbol,
        fullSymbol: symbol,
        maxLeverage: market.limits.leverage?.max || 200,
        minAmount: market.limits.amount?.min || 1,
        contractSize: market.contractSize || 1
      };
    }
    res.json({ success: true, markets: marketData });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/positions', async (req, res) => {
  const { apiKey, secret } = req.query;
  try {
    const exchange = getExchange(apiKey as string, secret as string);
    const positions = await exchange.fetchPositions();
    const activePositions = positions.filter((p: any) => p.contracts && p.contracts > 0);
    
    const simplified = activePositions.map((p: any) => ({
      symbol: p.symbol,
      baseSymbol: p.symbol.split('/')[0],
      side: p.side,
      leverage: p.leverage,
      contracts: p.contracts,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      liquidationPrice: p.liquidationPrice,
      unrealizedPnl: p.unrealizedPnl,
      percentage: p.percentage,
      margin: p.initialMargin
    }));

    res.json({ success: true, positions: simplified });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/update-tpsl', async (req, res) => {
  const { apiKey, secret, symbol, side, takeProfit, stopLoss } = req.body;
  try {
    const exchange = getExchange(apiKey, secret);
    await exchange.loadMarkets();
    const fullSymbol = `${symbol}/USDT:USDT`;
    
    const positions = await exchange.fetchPositions();
    const expectedSide = side === 'buy' ? 'long' : 'short';
    
    const pos = positions.find((p: any) => 
      (p.symbol === fullSymbol || p.symbol === `${symbol}/USDT` || p.symbol === `${symbol}_USDT`) && 
      p.side === expectedSide
    );
    
    if (!pos || !pos.contracts || pos.contracts <= 0) {
      return res.json({ success: false, message: `Position not found for ${symbol}` });
    }

    const openOrders = await exchange.fetchOpenOrders(fullSymbol, undefined, undefined, { stop: true });
    for (const order of openOrders) {
      if (order.info && (order.info.type === '3' || order.info.type === '4' || order.info.orderType === '3' || order.info.orderType === '4')) {
        try {
          await exchange.cancelOrder(order.id, fullSymbol);
        } catch (e) {}
      }
    }

    const closeSide = side === 'buy' ? 'sell' : 'buy';
    const results = [];

    if (takeProfit && parseFloat(takeProfit) > 0) {
      try {
        await exchange.createOrder(fullSymbol, 'limit', closeSide, pos.contracts, parseFloat(takeProfit), {
          stopPrice: parseFloat(takeProfit),
          triggerPrice: parseFloat(takeProfit),
          type: '1', // Market Take Profit
          reduceOnly: true
        });
        results.push('TP set');
      } catch (e: any) {}
    }

    if (stopLoss && parseFloat(stopLoss) > 0) {
      try {
        await exchange.createOrder(fullSymbol, 'limit', closeSide, pos.contracts, parseFloat(stopLoss), {
          stopPrice: parseFloat(stopLoss),
          triggerPrice: parseFloat(stopLoss),
          type: '2', // Market Stop Loss
          reduceOnly: true
        });
        results.push('SL set');
      } catch (e: any) {}
    }

    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/bulk-update-tpsl', async (req, res) => {
  const { apiKey, secret, configs } = req.body;
  try {
    const exchange = getExchange(apiKey, secret);
    await exchange.loadMarkets();
    const positions = await exchange.fetchPositions();
    const results = [];
    const errors = [];

    for (const config of configs) {
      try {
        const fullSymbol = `${config.symbol}/USDT:USDT`;
        const expectedSide = config.side === 'buy' ? 'long' : 'short';
        const pos = positions.find((p: any) => 
          (p.symbol === fullSymbol || p.symbol === `${config.symbol}/USDT` || p.symbol === `${config.symbol}_USDT`) && 
          p.side === expectedSide
        );

        if (pos && pos.contracts > 0) {
          const closeSide = config.side === 'buy' ? 'sell' : 'buy';
          const openOrders = await exchange.fetchOpenOrders(fullSymbol, undefined, undefined, { stop: true });
          for (const order of openOrders) {
            if (order.info && (order.info.type === '3' || order.info.type === '4')) {
              await exchange.cancelOrder(order.id, fullSymbol);
            }
          }

          if (config.takeProfit && parseFloat(config.takeProfit) > 0) {
            await exchange.createOrder(fullSymbol, 'limit', closeSide, pos.contracts, parseFloat(config.takeProfit), {
              stopPrice: parseFloat(config.takeProfit),
              triggerPrice: parseFloat(config.takeProfit),
              type: '1', // Market TP
              reduceOnly: true
            });
          }
          if (config.stopLoss && parseFloat(config.stopLoss) > 0) {
            await exchange.createOrder(fullSymbol, 'limit', closeSide, pos.contracts, parseFloat(config.stopLoss), {
              stopPrice: parseFloat(config.stopLoss),
              triggerPrice: parseFloat(config.stopLoss),
              type: '2', // Market SL
              reduceOnly: true
            });
          }
          results.push({ symbol: config.symbol, success: true });
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (e: any) {
        errors.push({ symbol: config.symbol, error: e.message });
      }
    }
    res.json({ success: true, results, errors });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

let activeMonitoring = false;
let monitorConfig: any = null;

async function executeCloseAll(apiKey: string, secret: string) {
  const exchange = getExchange(apiKey, secret);
  await exchange.loadMarkets();
  const positions = await exchange.fetchPositions();
  const results = [];
  const errors = [];

  for (const position of positions) {
    if (position.contracts && position.contracts > 0) {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const side = position.side === 'long' ? 'sell' : 'buy';
        const order = await exchange.createOrder(
          position.symbol,
          'market',
          side,
          position.contracts,
          undefined,
          { reduceOnly: true }
        );
        results.push({ symbol: position.symbol, order });
      } catch (e: any) {
        errors.push({ symbol: position.symbol, error: e.message });
      }
    }
  }
  return { results, errors };
}

async function startMonitoring() {
  activeMonitoring = true;
  logAction("Monitoring loop started");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  while(activeMonitoring && monitorConfig) {
    try {
      const exchange = getExchange(monitorConfig.apiKey, monitorConfig.secret);
      const positions = await exchange.fetchPositions();
      let triggerCloseAll = false;
      
      for (const leader of monitorConfig.leaders) {
        const symbol = leader.symbol + '/USDT:USDT';
        const expectedSide = leader.side === 'buy' ? 'long' : 'short';
        const pos = positions.find((p: any) => p.symbol === symbol && p.side === expectedSide);
        
        if (!pos || !pos.contracts || pos.contracts === 0) {
          logAction(`Leader ${symbol} position closed. Triggering Close All.`);
          triggerCloseAll = true;
          break;
        }
      }
      
      if (triggerCloseAll && activeMonitoring) {
        await executeCloseAll(monitorConfig.apiKey, monitorConfig.secret);
        activeMonitoring = false;
        break; 
      }
    } catch (e: any) {
      // Silently retry on network errors
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

app.post('/api/open-positions', async (req, res) => {
  const { apiKey, secret, orders } = req.body;
  try {
    const exchange = getExchange(apiKey, secret);
    await exchange.loadMarkets();
    const results = [];
    const errors = [];
    
    // Reset monitoring
    activeMonitoring = false;
    monitorConfig = null;
    await new Promise(resolve => setTimeout(resolve, 500));

    for (const order of orders) {
      try {
        // Find the correct symbol mapping
        const markets = exchange.markets;
        const market = markets[order.symbol] || markets[order.symbol + '/USDT:USDT'] || markets[order.symbol + '/USDT'];
        if (!market) throw new Error(`Symbol ${order.symbol} not found`);

        const symbol = market.symbol;

        if (order.leverage) {
          try {
            const positionType = order.side === 'buy' ? 1 : 2;
            await exchange.setLeverage(order.leverage, symbol, { openType: 2, positionType });
          } catch (e: any) {
            logAction(`Leverage set error for ${symbol}: ${e.message}`);
          }
        }

        // Calculate amount
        const amountUsdt = parseFloat(order.amount);
        const leverage = parseInt(order.leverage || '1');
        const positionUsdt = amountUsdt * leverage;
        
        let amount = order.amount;
        if (order.isUsdtAmount) {
           const ticker = await exchange.fetchTicker(symbol);
           const coinAmount = positionUsdt / ticker.last;
           const contractSize = market.contractSize || 1;
           amount = Math.round(coinAmount / contractSize);
           if (amount < 1) throw new Error(`Amount ${amount} too low for ${symbol}`);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Prepare TP/SL params for atomic order creation
        const params: any = { reduceOnly: false };
        
        // Smart Validation: ensure TP/SL are in correct direction
        let tpVal = order.takeProfit ? parseFloat(order.takeProfit) : 0;
        let slVal = order.stopLoss ? parseFloat(order.stopLoss) : 0;
        
        // If both provided, ensure they aren't reversed
        if (tpVal > 0 && slVal > 0) {
          if (order.side === 'buy') { // Long
            if (tpVal < slVal) { [tpVal, slVal] = [slVal, tpVal]; }
          } else { // Short
            if (tpVal > slVal) { [tpVal, slVal] = [slVal, tpVal]; }
          }
        }

        if (tpVal > 0) {
          params.takeProfitPrice = tpVal;
          params.tpTriggerBy = 1; // Last Price
        }
        if (slVal > 0) {
          params.stopLossPrice = slVal;
          params.slTriggerBy = 1; // Last Price
        }

        // Cancel existing trigger orders for this symbol first
        try {
          const openOrders = await exchange.fetchOpenOrders(symbol, undefined, undefined, { stop: true });
          for (const o of openOrders) {
             if (o.info && (['1', '2', '3', '4'].includes(o.info.type) || ['1', '2', '3', '4'].includes(o.info.orderType))) {
               try { await exchange.cancelOrder(o.id, symbol); } catch (e) {}
             }
          }
        } catch (e) {}

        // Create atomic market order with TP/SL
        const createdOrder = await exchange.createOrder(symbol, 'market', order.side, amount, undefined, params);
        results.push({ symbol: order.symbol, order: createdOrder });

        // Small delay between different coins to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e: any) {
        logAction(`Open position error for ${order.symbol}: ${e.message}`);
        errors.push({ symbol: order.symbol, error: e.message });
      }
    }

    const successfulSymbols = results.map((r: any) => r.symbol);
    const validLeaders = orders.filter((o: any) => o.isLeader && successfulSymbols.includes(o.symbol));
    
    if (validLeaders.length > 0) {
      monitorConfig = { apiKey, secret, leaders: validLeaders.map((o: any) => ({ symbol: o.symbol, side: o.side })) };
      startMonitoring();
    }
    res.json({ success: true, results, errors });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/close-all', async (req, res) => {
  const { apiKey, secret } = req.body;
  try {
    const { results, errors } = await executeCloseAll(apiKey, secret);
    res.json({ success: true, results, errors });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.listen(3001, () => console.log('Backend running on port 3001'));
