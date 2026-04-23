import express from 'express';
import cors from 'cors';
import ccxt from 'ccxt';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const logFile = path.join(__dirname, 'trade.log');
const logAction = (message: string) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  fs.appendFileSync(logFile, logMessage);
};

// Helper function to create exchange instance
const getExchange = (apiKey: string, secret: string) => {
  return new ccxt.mexc({
    apiKey,
    secret,
    enableRateLimit: true,
    options: {
      defaultType: 'swap', // Set to futures (swap)
    },
  });
};

const configFile = path.join(__dirname, 'config.json');

app.get('/api/config', (req, res) => {
  try {
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      res.json({ success: true, config });
    } else {
      res.json({ success: true, config: {} });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(configFile, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/connect', async (req, res) => {
  const { apiKey, secret } = req.body;
  try {
    const exchange = getExchange(apiKey, secret);
    // Fetch balance to verify credentials
    const balance = await exchange.fetchBalance();
    res.json({ success: true, balance: balance.USDT?.free || 0 });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
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
      if (symbol.endsWith('/USDT:USDT')) {
        const baseSymbol = symbol.split('/')[0];
        marketData[baseSymbol] = {
          maxLeverage: market.limits?.leverage?.max || (market.info as any).maxLeverage || 100,
          precision: market.precision,
          contractSize: market.contractSize
        };
      }
    }
    res.json({ success: true, markets: marketData });
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
    const pos = positions.find((p: any) => p.symbol === fullSymbol && p.side === expectedSide);
    
    if (!pos || !pos.contracts || pos.contracts <= 0) {
      return res.json({ success: false, message: '找不到對應的持倉，無法單獨更新止盈止損' });
    }

    const amount = pos.contracts;
    const closeSide = side === 'buy' ? 'sell' : 'buy';

    const openOrders = await exchange.fetchOpenOrders(fullSymbol);
    for (const order of openOrders) {
      if (order.stopPrice || (order.type && (order.type.includes('STOP') || order.type.includes('PROFIT')))) {
        try {
          await exchange.cancelOrder(order.id, fullSymbol);
        } catch (e) {
          console.error(`Cancel order ${order.id} failed:`, e);
        }
      }
    }

    const results = [];
    if (takeProfit && !isNaN(parseFloat(takeProfit))) {
      const tpOrder = await exchange.createOrder(fullSymbol, 'market', closeSide, amount, undefined, {
        stopPrice: parseFloat(takeProfit),
        type: 'TAKE_PROFIT_MARKET',
        reduceOnly: true
      });
      results.push({ type: 'TP', order: tpOrder });
    }

    if (stopLoss && !isNaN(parseFloat(stopLoss))) {
      const slOrder = await exchange.createOrder(fullSymbol, 'market', closeSide, amount, undefined, {
        stopPrice: parseFloat(stopLoss),
        type: 'STOP_LOSS_MARKET',
        reduceOnly: true
      });
      results.push({ type: 'SL', order: slOrder });
    }

    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

let activeMonitoring = false;
let monitorConfig: any = null;

async function executeCloseAll(apiKey: string, secret: string) {
  activeMonitoring = false; // Stop monitoring if manually triggered or triggered by leader
  const exchange = getExchange(apiKey, secret);
  await exchange.loadMarkets();
  const positions = await exchange.fetchPositions();
  
  const results = [];
  const errors = [];
  logAction(`\n=== 執行一鍵平倉 ===`);

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
        logAction(`[成功] 平倉 ${position.symbol} | 數量: ${position.contracts} 張`);
        results.push({ symbol: position.symbol, order });
      } catch (e: any) {
        logAction(`[失敗] 平倉 ${position.symbol} 失敗 | 錯誤原因: ${e.message}`);
        errors.push({ symbol: position.symbol, error: e.message });
      }
    }
  }
  return { results, errors };
}

async function startMonitoring() {
  activeMonitoring = true;
  logAction(`\n👀 [監控啟動] 開始監控帶頭幣種的實際倉位狀態...`);
  
  // 延遲 3 秒再開始首次檢查，確保 MEXC 倉位已經完全更新
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  while(activeMonitoring && monitorConfig) {
    try {
      const exchange = getExchange(monitorConfig.apiKey, monitorConfig.secret);
      // 取得最新的所有真實倉位
      const positions = await exchange.fetchPositions();
      
      let triggerCloseAll = false;
      let triggerReason = '';
      
      for (const leader of monitorConfig.leaders) {
        const symbol = `${leader.symbol}/USDT:USDT`;
        const expectedSide = leader.side === 'buy' ? 'long' : 'short';
        const pos = positions.find((p: any) => p.symbol === symbol && p.side === expectedSide);
        
        // 如果帶頭幣種的倉位不見了，或者數量變成 0，代表它剛剛被交易所平倉了！
        if (!pos || !pos.contracts || pos.contracts === 0) {
          triggerCloseAll = true;
          triggerReason = `${leader.symbol} 的帶頭倉位已被平倉 (觸及止盈/止損/或手動平倉)`;
          break;
        }
      }
      
      if (triggerCloseAll && activeMonitoring) {
        logAction(`\n🔔 [帶頭老大觸發] ${triggerReason}！立即啟動一鍵全平倉！`);
        await executeCloseAll(monitorConfig.apiKey, monitorConfig.secret);
        break; // Exit loop after closing all
      }
      
    } catch (e: any) {
      console.log(`[監控] 網路延遲或錯誤: ${e.message}`);
    }
    // Check every 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

app.post('/api/open-positions', async (req, res) => {
  const { apiKey, secret, orders } = req.body;
  // orders: Array of { symbol, amount, leverage, type, side, takeProfit, stopLoss, isLeader }
  try {
    const exchange = getExchange(apiKey, secret);
    await exchange.loadMarkets();

    const results = [];
    const errors = [];
    logAction(`\n=== 收到批量開倉請求: 共 ${orders.length} 個幣種 ===`);



    // Execute market orders
    for (const order of orders) {
      try {
        const symbol = `${order.symbol}/USDT:USDT`;
        const market = exchange.markets[symbol];
        if (!market) throw new Error(`Market ${symbol} not found`);

        // 嚴格設定槓桿 (只用全倉)
        if (order.leverage) {
          try {
            const positionType = order.side === 'buy' ? 1 : 2;
            await exchange.setLeverage(order.leverage, symbol, { openType: 2, positionType });
            logAction(`[系統] 成功設定 ${order.symbol} 全倉槓桿為 ${order.leverage}x`);
          } catch (e: any) {
            throw new Error(`設定全倉槓桿失敗: ${e.message}。請確保您的 MEXC 帳戶處於全倉模式，或是該幣種支援全倉。`);
          }
        }

        // User inputs USDT as margin amount. Total position = Margin * Leverage
        let amount = order.amount;
        let positionUsdt = order.amount * (order.leverage || 1);
        
        if (order.isUsdtAmount) {
           const ticker = await exchange.fetchTicker(symbol);
           // Calculate total coins needed for the position
           const coinAmount = positionUsdt / ticker.last;
           
           if (market.contractSize) {
               // Calculate number of contracts. 嚴格按照使用者輸入的金額計算
               amount = Math.round(coinAmount / market.contractSize);
               
               if (amount < 1) {
                   const requiredUsdt = (market.contractSize * ticker.last) / (order.leverage || 1);
                   throw new Error(`您設定的 ${order.amount} USDT 本金不足以購買最少 1 張合約。該幣種在 ${order.leverage}x 槓桿下，最少需要約 ${requiredUsdt.toFixed(2)} USDT 才能開倉。`);
               }
               
               const estimatedCost = (amount * market.contractSize * ticker.last) / (order.leverage || 1);
               logAction(`[計算] ${order.symbol}: 目標成本 ${order.amount}u -> 實際買入 ${amount} 張 -> 實際消耗本金約 ${estimatedCost.toFixed(4)}u`);
           } else {
               amount = exchange.amountToPrecision(symbol, coinAmount) as any;
           }
        }

        // Mexc might require specific params for TP/SL.
        // CCXT unified params: takeProfitPrice, stopLossPrice
        const params: any = {};
        if (order.takeProfit) {
            params.takeProfitPrice = order.takeProfit;
        }
        if (order.stopLoss) {
            params.stopLossPrice = order.stopLoss;
        }

        // Add small delay to prevent MEXC rate limit "Requests are too frequent"
        await new Promise(resolve => setTimeout(resolve, 500));

        const createdOrder = await exchange.createOrder(
          symbol,
          'market',
          order.side, // 'buy' or 'sell'
          amount,
          undefined, // price not needed for market order
          params
        );
        logAction(`[成功] ${order.symbol} ${order.side} 開倉成功 | 數量: ${amount} 張 | 槓桿: ${order.leverage}x`);
        results.push({ symbol: order.symbol, order: createdOrder });
      } catch (e: any) {
        logAction(`[失敗] ${order.symbol} 開倉失敗 | 錯誤原因: ${e.message}`);
        errors.push({ symbol: order.symbol, error: e.message });
      }
    }

    // 確保只監控 "成功開倉" 且 "設定為帶頭" 的幣種
    const successfulSymbols = results.map((r: any) => r.symbol);
    const validLeaders = orders.filter((o: any) => o.isLeader && successfulSymbols.includes(o.symbol));
    
    if (validLeaders.length > 0) {
      monitorConfig = {
        apiKey,
        secret,
        leaders: validLeaders.map((o: any) => ({
          symbol: o.symbol,
          side: o.side
        }))
      };
      if (!activeMonitoring) {
        startMonitoring(); // Run async without awaiting
      }
    } else {
      activeMonitoring = false; // Stop existing monitoring if new orders have no leaders
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

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
