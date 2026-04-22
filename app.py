import os
import json
import time
from flask import Flask, request, jsonify
from flask_cors import CORS
import ccxt

app = Flask(__name__)
CORS(app)  # 允許前端跨域請求

CONFIG_FILE = 'config.json'
LOG_FILE = 'trade.log'

def log_action(message):
    timestamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    log_msg = f"[{timestamp}] {message}"
    print(log_msg)
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(log_msg + '\n')

def get_exchange(api_key, secret):
    return ccxt.mexc({
        'apiKey': api_key,
        'secret': secret,
        'enableRateLimit': True,
        'options': {'defaultType': 'swap'}
    })

@app.route('/api/config', methods=['GET'])
def get_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return jsonify({'success': True, 'config': json.load(f)})
    return jsonify({'success': True, 'config': {}})

@app.route('/api/config', methods=['POST'])
def save_config():
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(request.json, f, indent=2)
    return jsonify({'success': True})

@app.route('/api/connect', methods=['POST'])
def connect():
    data = request.json
    try:
        exchange = get_exchange(data['apiKey'], data['secret'])
        balance = exchange.fetch_balance()
        usdt_free = balance.get('USDT', {}).get('free', 0)
        return jsonify({'success': True, 'balance': usdt_free})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400

@app.route('/api/open-positions', methods=['POST'])
def open_positions():
    data = request.json
    exchange = get_exchange(data['apiKey'], data['secret'])
    orders = data.get('orders', [])
    
    try:
        exchange.load_markets()
        results = []
        errors = []
        
        log_action(f"\n=== 收到批量開倉請求: 共 {len(orders)} 個幣種 ===")
        
        for order in orders:
            try:
                symbol = f"{order['symbol']}/USDT:USDT"
                market = exchange.markets.get(symbol)
                if not market:
                    raise Exception(f"找不到幣種 {symbol}")
                
                # 嚴格設定槓桿 (全倉)
                if order.get('leverage'):
                    try:
                        pos_type = 1 if order['side'] == 'buy' else 2
                        exchange.set_leverage(int(order['leverage']), symbol, params={'openType': 2, 'positionType': pos_type})
                        log_action(f"[系統] 成功設定 {order['symbol']} 全倉槓桿為 {order['leverage']}x")
                    except Exception as e:
                        raise Exception(f"設定全倉槓桿失敗: {e}")
                
                # 計算合約張數
                amount_usdt = float(order['amount'])
                leverage = int(order.get('leverage', 1))
                position_usdt = amount_usdt * leverage
                
                if order.get('isUsdtAmount'):
                    ticker = exchange.fetch_ticker(symbol)
                    coin_amount = position_usdt / ticker['last']
                    
                    contract_size = market.get('contractSize')
                    if contract_size:
                        amount = round(coin_amount / contract_size)
                        if amount < 1:
                            required = (contract_size * ticker['last']) / leverage
                            raise Exception(f"您設定的 {amount_usdt} USDT 本金不足以購買最少 1 張合約。該幣種最少需要約 {required:.2f} USDT 才能開倉。")
                        
                        est_cost = (amount * contract_size * ticker['last']) / leverage
                        log_action(f"[計算] {order['symbol']}: 目標成本 {amount_usdt}u -> 實際買入 {amount} 張 -> 實際消耗本金約 {est_cost:.4f}u")
                    else:
                        amount = float(exchange.amount_to_precision(symbol, coin_amount))
                        if amount <= 0:
                            raise Exception("計算數量為 0")
                else:
                    amount = float(order['amount'])
                    
                # 停損停利參數
                params = {}
                if order.get('takeProfit'): params['takeProfitPrice'] = float(order['takeProfit'])
                if order.get('stopLoss'): params['stopLossPrice'] = float(order['stopLoss'])
                
                # 延遲防防護限制
                time.sleep(0.5)
                
                created = exchange.create_order(symbol, 'market', order['side'], amount, None, params)
                log_action(f"[成功] {order['symbol']} {order['side']} 開倉成功 | 數量: {amount} 張 | 槓桿: {leverage}x")
                results.append({'symbol': order['symbol'], 'order': created})
                
            except Exception as e:
                log_action(f"[失敗] {order['symbol']} 開倉失敗 | 錯誤原因: {e}")
                errors.append({'symbol': order['symbol'], 'error': str(e)})
                
        return jsonify({'success': True, 'results': results, 'errors': errors})
        
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400

@app.route('/api/close-all', methods=['POST'])
def close_all():
    data = request.json
    exchange = get_exchange(data['apiKey'], data['secret'])
    
    try:
        exchange.load_markets()
        positions = exchange.fetch_positions()
        
        results = []
        errors = []
        log_action("\n=== 收到一鍵平倉請求 ===")
        
        for p in positions:
            contracts = float(p.get('contracts', 0))
            if contracts > 0:
                try:
                    time.sleep(0.5)
                    side = 'sell' if p['side'] == 'long' else 'buy'
                    order = exchange.create_order(p['symbol'], 'market', side, contracts, None, {'reduceOnly': True})
                    log_action(f"[成功] 平倉 {p['symbol']} | 數量: {contracts} 張")
                    results.append({'symbol': p['symbol'], 'order': order})
                except Exception as e:
                    log_action(f"[失敗] 平倉 {p['symbol']} 失敗 | 錯誤原因: {e}")
                    errors.append({'symbol': p['symbol'], 'error': str(e)})
                    
        return jsonify({'success': True, 'results': results, 'errors': errors})
        
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400

if __name__ == '__main__':
    print("Python Backend API running on http://127.0.0.1:3001")
    app.run(port=3001, debug=True)
