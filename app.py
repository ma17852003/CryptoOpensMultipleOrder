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

@app.route('/api/markets', methods=['GET'])
def get_markets():
    api_key = request.args.get('apiKey')
    secret = request.args.get('secret')
    try:
        exchange = get_exchange(api_key, secret)
        markets = exchange.load_markets()
        market_data = {}
        for symbol, market in markets.items():
            if symbol.endswith('/USDT:USDT'):
                base_symbol = symbol.split('/')[0]
                market_data[base_symbol] = {
                    'maxLeverage': market.get('limits', {}).get('leverage', {}).get('max') or market.get('info', {}).get('maxLeverage') or 100,
                    'precision': market.get('precision'),
                    'contractSize': market.get('contractSize')
                }
        return jsonify({'success': True, 'markets': market_data})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/update-tpsl', methods=['POST'])
def update_tpsl():
    data = request.json
    api_key = data.get('apiKey')
    secret = data.get('secret')
    symbol = data.get('symbol')
    side = data.get('side')
    tp = data.get('takeProfit')
    sl = data.get('stopLoss')
    
    try:
        exchange = get_exchange(api_key, secret)
        exchange.load_markets()
        full_symbol = f"{symbol}/USDT:USDT"
        
        positions = exchange.fetch_positions()
        expected_side = 'long' if side == 'buy' else 'short'
        pos = next((p for p in positions if p['symbol'] == full_symbol and p.get('side') == expected_side), None)
        
        if not pos or not pos.get('contracts') or float(pos['contracts']) <= 0:
            return jsonify({'success': False, 'message': '找不到對應持倉'})
            
        amount = float(pos['contracts'])
        close_side = 'sell' if side == 'buy' else 'buy'
        
        # 取消舊的計畫委託
        open_orders = exchange.fetch_open_orders(full_symbol)
        for o in open_orders:
            if o.get('stopPrice') or (o.get('type') and ('STOP' in o['type'] or 'PROFIT' in o['type'])):
                try:
                    exchange.cancel_order(o['id'], full_symbol)
                except:
                    pass
                    
        results = []
        if tp and str(tp).strip():
            order = exchange.create_order(full_symbol, 'market', close_side, amount, None, {
                'stopPrice': float(tp),
                'type': 'TAKE_PROFIT_MARKET',
                'reduceOnly': True
            })
            results.append({'type': 'TP', 'order': order})
            
        if sl and str(sl).strip():
            order = exchange.create_order(full_symbol, 'market', close_side, amount, None, {
                'stopPrice': float(sl),
                'type': 'STOP_LOSS_MARKET',
                'reduceOnly': True
            })
            results.append({'type': 'SL', 'order': order})
            
        return jsonify({'success': True, 'results': results})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

import threading

active_monitoring = False
monitor_config = None

def execute_close_all(api_key, secret):
    global active_monitoring
    active_monitoring = False
    
    exchange = get_exchange(api_key, secret)
    exchange.load_markets()
    positions = exchange.fetch_positions()
    
    results = []
    errors = []
    log_action("\n=== 執行一鍵平倉 ===")
    
    for p in positions:
        contracts = p.get('contracts')
        contracts = float(contracts) if contracts is not None else 0.0
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
                
    return results, errors

def monitoring_loop():
    global active_monitoring, monitor_config
    log_action("\n👀 [監控啟動] 開始監控帶頭幣種的實際倉位狀態...")
    
    time.sleep(3) # 延遲 3 秒確保開倉完畢
    
    while active_monitoring and monitor_config:
        try:
            exchange = get_exchange(monitor_config['apiKey'], monitor_config['secret'])
            positions = exchange.fetch_positions()
            
            trigger_close_all = False
            trigger_reason = ""
            
            for leader in monitor_config['leaders']:
                symbol = f"{leader['symbol']}/USDT:USDT"
                expected_side = 'long' if leader['side'] == 'buy' else 'short'
                pos = next((p for p in positions if p['symbol'] == symbol and p.get('side') == expected_side), None)
                
                # 如果找不到倉位，或數量為 0，代表已經被平倉
                if not pos or not pos.get('contracts') or float(pos['contracts']) == 0:
                    trigger_close_all = True
                    trigger_reason = f"{leader['symbol']} 的帶頭倉位已被平倉 (觸發止盈/止損或手動平倉)"
                    break
                    
            if trigger_close_all and active_monitoring:
                log_action(f"\n🔔 [帶頭老大觸發] {trigger_reason}！立即啟動一鍵全平倉！")
                execute_close_all(monitor_config['apiKey'], monitor_config['secret'])
                break
                
        except Exception as e:
            print(f"[監控] 網路延遲或錯誤: {e}")
            
        time.sleep(2)

@app.route('/api/open-positions', methods=['POST'])
def open_positions():
    global active_monitoring, monitor_config
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
                
        
        # 確保只監控成功開倉的帶頭幣種
        successful_symbols = [r['symbol'] for r in results]
        valid_leaders = [o for o in orders if o.get('isLeader') and o['symbol'] in successful_symbols]
        
        if valid_leaders:
            monitor_config = {
                'apiKey': data['apiKey'],
                'secret': data['secret'],
                'leaders': [{'symbol': o['symbol'], 'side': o['side']} for o in valid_leaders]
            }
            if not active_monitoring:
                active_monitoring = True
                threading.Thread(target=monitoring_loop, daemon=True).start()
        else:
            active_monitoring = False
            
        return jsonify({'success': True, 'results': results, 'errors': errors})
        
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400

@app.route('/api/close-all', methods=['POST'])
def close_all():
    data = request.json
    try:
        results, errors = execute_close_all(data['apiKey'], data['secret'])
        return jsonify({'success': True, 'results': results, 'errors': errors})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400

if __name__ == '__main__':
    print("Python Backend API running on http://127.0.0.1:3001")
    app.run(port=3001, debug=True)
