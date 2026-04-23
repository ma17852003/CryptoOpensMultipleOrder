import { useState, useEffect } from 'react';
import axios from 'axios';
import { Settings, Play, Square, Trash2, Plus, Zap, AlertCircle, CheckCircle2, Star } from 'lucide-react';
import './index.css';

// Default mainstream coins based on user request
const DEFAULT_COINS = ['BTC', 'ETH', 'SUI', 'XRP', 'DOGE', 'PEPE', 'ADA', 'SOL'];

interface OrderConfig {
  id: string;
  symbol: string;
  amount: string;
  isUsdtAmount: boolean;
  leverage: string;
  side: 'buy' | 'sell';
  takeProfit?: string;
  stopLoss?: string;
  isLeader?: boolean;
}

interface ExchangePosition {
  symbol: string;
  baseSymbol: string;
  side: string;
  leverage: number;
  contracts: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
  percentage?: number;
  liquidationPrice?: number;
  margin?: number;
}

const API_BASE = 'http://localhost:3001/api';

function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('mexc_api_key') || '');
  const [apiSecret, setApiSecret] = useState(localStorage.getItem('mexc_api_secret') || '');
  const [isConnected, setIsConnected] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [markets, setMarkets] = useState<Record<string, any>>({});
  const [exchangePositions, setExchangePositions] = useState<ExchangePosition[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const [bulkConfig, setBulkConfig] = useState({
    side: 'buy' as 'buy' | 'sell',
    amount: '10'
  });
  
  const [orders, setOrders] = useState<OrderConfig[]>(() => {
    const saved = localStorage.getItem('mexc_orders');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return [];
      }
    }
    return [];
  });
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error'} | null>(null);
  const [loading, setLoading] = useState(false);
  const [customCoin, setCustomCoin] = useState('');
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);

  useEffect(() => {
    axios.get(`${API_BASE}/config`).then(res => {
      if (res.data.success && res.data.config) {
        if (res.data.config.apiKey) setApiKey(res.data.config.apiKey);
        if (res.data.config.apiSecret) setApiSecret(res.data.config.apiSecret);
        if (res.data.config.orders && res.data.config.orders.length > 0) setOrders(res.data.config.orders);
      }
      setIsConfigLoaded(true);
    }).catch(() => {
      setIsConfigLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!isConfigLoaded) return;
    
    localStorage.setItem('mexc_api_key', apiKey);
    localStorage.setItem('mexc_api_secret', apiSecret);
    localStorage.setItem('mexc_orders', JSON.stringify(orders));
    
    axios.post(`${API_BASE}/config`, { apiKey, apiSecret, orders }).catch(() => {});
  }, [apiKey, apiSecret, orders, isConfigLoaded]);

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const fetchPositions = async () => {
    if (!apiKey || !apiSecret) return;
    try {
      const res = await axios.get(`${API_BASE}/positions`, {
        params: { apiKey, secret: apiSecret }
      });
      if (res.data.success) {
        setExchangePositions(res.data.positions);
      }
    } catch (err) {
      console.error('Failed to fetch positions:', err);
    }
  };

  useEffect(() => {
    if (isConnected) {
      fetchPositions();
      const interval = setInterval(fetchPositions, 5000);
      return () => clearInterval(interval);
    }
  }, [isConnected]);

  const handleConnect = async () => {
    if (!apiKey || !apiSecret) {
      showNotification('請輸入 API Key 和 Secret', 'error');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/connect`, { apiKey, secret: apiSecret });
      if (res.data.success) {
        setIsConnected(true);
        setBalance(res.data.balance);
        showNotification('成功連接到 MEXC 帳戶', 'success');
      }
    } catch (err: any) {
      showNotification(err.response?.data?.message || err.message, 'error');
      setIsConnected(false);
    }
    setLoading(false);
  };

  const fetchMarkets = async () => {
    if (!apiKey || !apiSecret) return;
    try {
      const res = await axios.get(`${API_BASE}/markets`, {
        params: { apiKey, secret: apiSecret }
      });
      if (res.data.success) {
        setMarkets(res.data.markets);
      }
    } catch (err) {
      console.error('Failed to fetch markets:', err);
    }
  };

  useEffect(() => {
    if (isConnected) {
      fetchMarkets();
    }
  }, [isConnected]);

  const applyBulkConfig = () => {
    setOrders(orders.map(o => ({
      ...o,
      side: bulkConfig.side,
      amount: bulkConfig.amount
    })));
    showNotification('已將統一設定套用到所有幣種', 'success');
  };

  const addCoin = (symbol: string) => {
    if (orders.some(o => o.symbol === symbol)) return;
    const newOrder: OrderConfig = {
      id: Math.random().toString(36).substring(7),
      symbol,
      amount: '10', // Default 10 USDT
      isUsdtAmount: true,
      leverage: '10',
      side: 'buy'
    };
    setOrders([...orders, newOrder]);
  };

  const removeCoin = (id: string) => {
    setOrders(orders.filter(o => o.id !== id));
  };

  const updateOrder = (id: string, field: keyof OrderConfig, value: any) => {
    setOrders(orders.map(o => o.id === id ? { ...o, [field]: value } : o));
  };

  const handleOpenAll = async () => {
    if (!isConnected) {
      showNotification('請先連接 API', 'error');
      return;
    }
    if (orders.length === 0) {
      showNotification('請至少添加一個幣種', 'error');
      return;
    }
    setLoading(true);
    try {
      const payloadOrders = orders.map(o => {
        // Simple validation check for TP/SL direction if possible
        // For now, we just pass them through but ensure they are numbers
        return {
          ...o,
          amount: Number(o.amount) || 0,
          leverage: Number(o.leverage) || 1,
          takeProfit: o.takeProfit ? Number(o.takeProfit) : undefined,
          stopLoss: o.stopLoss ? Number(o.stopLoss) : undefined
        };
      });
      
      // Check for reversed TP/SL for all symbols
      for (const o of payloadOrders) {
        if (o.takeProfit && o.stopLoss) {
          if (o.side === 'buy' && Number(o.takeProfit) < Number(o.stopLoss)) {
            if (!confirm(`警告：您的 ${o.symbol} 止盈低於止損（做多），這會被交易所拒絕。是否繼續？`)) {
              setLoading(false);
              return;
            }
          }
          if (o.side === 'sell' && Number(o.takeProfit) > Number(o.stopLoss)) {
            if (!confirm(`警告：您的 ${o.symbol} 止盈高於止損（做空），這會被交易所拒絕。是否繼續？`)) {
              setLoading(false);
              return;
            }
          }
        }
      }
      const res = await axios.post(`${API_BASE}/open-positions`, {
        apiKey,
        secret: apiSecret,
        orders: payloadOrders
      });
      
      if (res.data.success) {
        if (res.data.errors?.length > 0) {
          showNotification(`部分開倉成功，但有 ${res.data.errors.length} 個失敗`, 'error');
          console.error(res.data.errors);
        } else {
          showNotification(`成功同時開倉 ${res.data.results.length} 個幣種!`, 'success');
        }
      }
    } catch (err: any) {
      showNotification(err.response?.data?.message || err.message, 'error');
    }
    setLoading(false);
  };

  const handleCloseAll = async () => {
    if (!isConnected) {
      showNotification('請先連接 API', 'error');
      return;
    }
    if (!confirm('確定要一鍵平掉所有合約倉位嗎？這將會以市價平倉所有持倉。')) return;
    
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/close-all`, {
        apiKey,
        secret: apiSecret
      });
      
      if (res.data.success) {
        if (res.data.errors?.length > 0) {
          showNotification(`部分平倉成功，但有 ${res.data.errors.length} 個失敗`, 'error');
        } else {
          showNotification(`成功平掉所有倉位! 共 ${res.data.results.length} 個`, 'success');
        }
      }
    } catch (err: any) {
      showNotification(err.response?.data?.message || err.message, 'error');
    }
    setLoading(false);
  };

  return (
    <div className="app-container">
      <div className="header">
        <div>
          <h1 className="header-title">Crypto 一鍵開倉助手</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            支援 MEXC 合約交易 | 多幣種同步操作
          </p>
        </div>
        <div className="glass-panel" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span className={`status-indicator ${isConnected ? 'status-connected' : 'status-disconnected'}`}></span>
            <span>{isConnected ? '已連接' : '未連接'}</span>
          </div>
          {balance !== null && (
            <div style={{ fontWeight: 'bold', color: 'var(--success)' }}>
              $ {parseFloat(balance.toString()).toFixed(2)} USDT
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ marginBottom: '2rem' }}>
        <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Settings size={20} /> API 設定 (MEXC)
        </h2>
        <div className="settings-section">
          <div className="form-group">
            <label>API Key</label>
            <input 
              type="password" 
              className="input-field" 
              value={apiKey} 
              onChange={e => setApiKey(e.target.value)} 
              placeholder="輸入 MEXC API Key"
            />
          </div>
          <div className="form-group">
            <label>Secret Key</label>
            <input 
              type="password" 
              className="input-field" 
              value={apiSecret} 
              onChange={e => setApiSecret(e.target.value)} 
              placeholder="輸入 MEXC Secret Key"
            />
          </div>
        </div>
        <button 
          className="btn btn-primary" 
          onClick={handleConnect}
          disabled={loading}
        >
          {loading ? '連接中...' : '測試連接並獲取餘額'}
        </button>
      </div>

      <div className="glass-panel">
        <h2 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Zap size={20} /> 快速選擇幣種
        </h2>
        <div className="symbol-selector">
          {DEFAULT_COINS.map(coin => {
            const isActive = orders.some(o => o.symbol === coin);
            return (
              <div 
                key={coin} 
                className={`symbol-chip ${isActive ? 'active' : ''}`}
                onClick={() => isActive ? removeCoin(orders.find(o => o.symbol === coin)!.id) : addCoin(coin)}
              >
                {coin}
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input 
              type="text" 
              className="input-field" 
              style={{ width: '140px', padding: '0.4rem 0.8rem', borderRadius: '20px' }} 
              placeholder="例如: INJ" 
              value={customCoin}
              onChange={e => setCustomCoin(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === 'Enter' && customCoin) {
                  addCoin(customCoin);
                  setCustomCoin('');
                }
              }}
            />
            <button 
              className="btn btn-primary" 
              style={{ padding: '0.4rem 1rem', borderRadius: '20px', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
              onClick={() => {
                if (customCoin) {
                  addCoin(customCoin);
                  setCustomCoin('');
                }
              }}
            >
              <Plus size={16} /> 新增
            </button>
          </div>
        </div>

        {orders.length > 0 && (
          <div className="bulk-adjustment-panel glass-panel" style={{ margin: '1rem 0', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <h3 style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.8 }}>一鍵統一調整 (套用到下方所有幣種)</h3>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.8rem' }}>方向</label>
                <select 
                  className="input-field" 
                  value={bulkConfig.side}
                  onChange={e => setBulkConfig({...bulkConfig, side: e.target.value as any})}
                >
                  <option value="buy">全部做多</option>
                  <option value="sell">全部做空</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: '0.8rem' }}>金額 (USDT)</label>
                <input 
                  type="text" 
                  className="input-field" 
                  style={{ width: '100px' }}
                  value={bulkConfig.amount}
                  onChange={e => setBulkConfig({...bulkConfig, amount: e.target.value})}
                />
              </div>
              <button className="btn btn-primary" onClick={applyBulkConfig} style={{ height: '42px' }}>
                套用統一設定
              </button>
            </div>
          </div>
        )}

        {orders.length > 0 && (
          <div className="coin-table-wrapper">
            <table className="coin-table">
              <thead>
                <tr>
                  <th>幣種 (Symbol)</th>
                  <th>方向 (Side)</th>
                  <th>金額 (Amount USDT)</th>
                  <th>槓桿 (Leverage)</th>
                  <th>止盈 (Take Profit $)</th>
                  <th>止損 (Stop Loss $)</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id} style={{ backgroundColor: order.isLeader ? 'rgba(250, 204, 21, 0.1)' : 'transparent' }}>
                    <td style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <button 
                        className={`btn-icon ${order.isLeader ? 'active' : ''}`} 
                        onClick={() => updateOrder(order.id, 'isLeader', !order.isLeader)}
                        style={{ padding: '4px', color: order.isLeader ? '#facc15' : 'rgba(255,255,255,0.3)', border: 'none', background: 'transparent', cursor: 'pointer' }}
                        title="設為帶頭幣種"
                      >
                        <Star size={18} fill={order.isLeader ? '#facc15' : 'none'} />
                      </button>
                      {order.symbol}
                    </td>
                    <td>
                      <select 
                        className="input-field" 
                        style={{ padding: '0.5rem' }}
                        value={order.side}
                        onChange={e => updateOrder(order.id, 'side', e.target.value)}
                      >
                        <option value="buy">做多 (Long)</option>
                        <option value="sell">做空 (Short)</option>
                      </select>
                    </td>
                    <td>
                      <input 
                        type="text" 
                        className="input-field" 
                        style={{ width: '120px', padding: '0.5rem' }}
                        value={order.amount}
                        onChange={e => updateOrder(order.id, 'amount', e.target.value)}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <input 
                          type="text" 
                          className="input-field" 
                          style={{ width: '60px', padding: '0.5rem' }}
                          value={order.leverage}
                          onChange={e => updateOrder(order.id, 'leverage', e.target.value)}
                        />
                        <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                          x {markets[order.symbol] ? (
                            <span 
                              className="max-leverage-badge"
                              onClick={() => updateOrder(order.id, 'leverage', markets[order.symbol].maxLeverage.toString())}
                              title="點擊套用最大槓桿"
                            >
                              (Max: {markets[order.symbol].maxLeverage})
                            </span>
                          ) : ''}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <input 
                          type="text" 
                          className="input-field"
                          style={{ width: '120px', padding: '0.5rem' }}
                          placeholder="選填"
                          value={order.takeProfit || ''}
                          onChange={e => updateOrder(order.id, 'takeProfit', e.target.value)}
                        />
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <input 
                          type="text" 
                          className="input-field" 
                          style={{ width: '120px', padding: '0.5rem' }}
                          placeholder="選填"
                          value={order.stopLoss || ''}
                          onChange={e => updateOrder(order.id, 'stopLoss', e.target.value)}
                        />
                      </div>
                    </td>
                    <td>
                      <button className="btn-icon" onClick={() => removeCoin(order.id)}>
                        <Trash2 size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="action-buttons">
          <button className="btn btn-danger" onClick={handleCloseAll} disabled={loading || !isConnected}>
            <Square size={18} /> 一鍵平掉所有倉位
          </button>
          <button className="btn btn-success" onClick={handleOpenAll} disabled={loading || orders.length === 0 || !isConnected}>
            <Play size={18} /> 同時市價開倉 ({orders.length} 個)
          </button>
        </div>
      </div>

      {/* 當前持倉區塊 */}
      <div className="card" style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: 'var(--primary)' }}>●</span> 我的持倉 (交易所)
          </h2>
          <button 
            className="btn btn-secondary" 
            onClick={() => {
              setIsRefreshing(true);
              fetchPositions().finally(() => setIsRefreshing(false));
            }}
            disabled={isRefreshing}
            style={{ padding: '0.5rem 1rem', fontSize: '0.9rem' }}
          >
            {isRefreshing ? '刷新中...' : '手動刷新'}
          </button>
        </div>

        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>交易對 (Symbol)</th>
                <th>方向 (Side)</th>
                <th>槓桿 (Lev)</th>
                <th>倉位 (Size)</th>
                <th>均價 (Entry)</th>
                <th>本金 (Margin)</th>
                <th>盈虧 (PnL)</th>
                <th>強平價 (Liq)</th>
              </tr>
            </thead>
            <tbody>
              {exchangePositions.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                    目前無持有倉位
                  </td>
                </tr>
              ) : (
                exchangePositions.map((pos, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 'bold' }}>{pos.baseSymbol}</td>
                    <td>
                      <span className={`badge ${pos.side === 'long' ? 'badge-success' : 'badge-danger'}`}>
                        {pos.side === 'long' ? '做多 (Long)' : '做空 (Short)'}
                      </span>
                    </td>
                    <td>{pos.leverage}x</td>
                    <td>{pos.contracts} 張</td>
                    <td>{pos.entryPrice?.toLocaleString()}</td>
                    <td>{pos.margin?.toFixed(2)} USDT</td>
                    <td style={{ color: (pos.unrealizedPnl || 0) >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 'bold' }}>
                      {pos.unrealizedPnl?.toFixed(4)} USDT ({pos.percentage?.toFixed(2)}%)
                    </td>
                    <td style={{ color: 'var(--warning)' }}>{pos.liquidationPrice?.toLocaleString() || '--'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {notification && (
        <div className={`notification ${notification.type}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {notification.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            {notification.message}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
