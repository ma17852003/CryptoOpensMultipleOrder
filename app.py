import os
import time
import threading
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import ccxt

app = Flask(__name__)
CORS(app)

LOG_FILE = "trade.log"

def log_action(message):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_message = f"[{timestamp}] {message}\n"
    print(message)
    with open(LOG_FILE, "a") as f:
        f.write(log_message)

def get_exchange(api_key, secret):
    return ccxt.mexc({
        'apiKey': api_key,
        'secret': secret,
        'options': {
            'defaultType': 'swap',
            'recvWindow': 10000,
            'adjustForTimeDifference': True
        }
    })

CONFIG_FILE = os.path.join("backend", "config.json")

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading config: {e}")
            return {}
    return {}

def save_config(config):
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, "w", encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving config: {e}")

@app.route('/api/connect', methods=['POST'])
def connect():
    data = request.json
    api_key = data.get('apiKey')
    secret = data.get('secret')
    try:
        exchange = get_exchange(api_key, secret)
        balance = exchange.fetch_balance()
        return jsonify({'success': True, 'balance': balance['total'].get('USDT', 0)})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/config', methods=['GET', 'POST'])
def handle_config():
    if request.method == 'GET':
        return jsonify({'success': True, 'config': load_config()})
    else:
        config = request.json
        save_config(config)
        return jsonify({'success': True})

@app.route('/api/balance', methods=['GET'])
def get_balance():
    api_key = request.args.get('apiKey')
    secret = request.args.get('secret')
    try:
        exchange = get_exchange(api_key, secret)
        balance = exchange.fetch_balance()
        return jsonify({'success': True, 'balance': balance['total'].get('USDT', 0)})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/markets', methods=['GET'])
def get_markets():
    api_key = request.args.get('apiKey')
    secret = request.args.get('secret')
    try:
        exchange = get_exchange(api_key, secret)
        markets = exchange.load_markets()
        market_data = {}
        for symbol, market in markets.items():
            base = symbol.split('/')[0]
            market_data[base] = {
                'symbol': base,
                'fullSymbol': symbol,
                'maxLeverage': market['limits'].get('leverage', {}).get('max', 200),
                'minAmount': market['limits'].get('amount', {}).get('min', 1),
                'contractSize': market.get('contractSize', 1)
            }
        return jsonify({'success': True, 'markets': market_data})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/positions', methods=['GET'])
def get_positions():
    api_key = request.args.get('apiKey')
    secret = request.args.get('secret')
    try:
        exchange = get_exchange(api_key, secret)
        positions = exchange.fetch_positions()
        active = [p for p in positions if p.get('contracts') and float(p['contracts']) > 0]
        simplified = []
        for p in active:
            simplified.append({
                'symbol': p['symbol'],
                'baseSymbol': p['symbol'].split('/')[0],
                'side': p['side'],
                'leverage': p['leverage'],
                'contracts': p['contracts'],
                'entryPrice': p['entryPrice'],
                'markPrice': p.get('markPrice'),
                'liquidationPrice': p.get('liquidationPrice'),
                'unrealizedPnl': p.get('unrealizedPnl'),
                'percentage': p.get('percentage'),
                'margin': p.get('initialMargin')
            })
        return jsonify({'success': True, 'positions': simplified})
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
        pos = next((p for p in positions if (p['symbol'] == full_symbol or p['symbol'] == f"{symbol}/USDT" or p['symbol'] == f"{symbol}_USDT") and p.get('side') == expected_side), None)
        
        if not pos or not pos.get('contracts') or float(pos['contracts']) <= 0:
            return jsonify({'success': False, 'message': f'Position not found for {symbol}'})
            
        open_orders = exchange.fetch_open_orders(full_symbol, params={'stop': True})
        for o in open_orders:
            if o['info'] and (o['info'].get('type') in ['3', '4'] or o['info'].get('orderType') in ['3', '4']):
                try:
                    exchange.cancel_order(o['id'], full_symbol)
                except:
                    pass
        
        close_side = 'sell' if side == 'buy' else 'buy'
        results = []
        if tp and float(tp) > 0:
            exchange.create_order(full_symbol, 'market', close_side, pos['contracts'], None, {
                'stopPrice': float(tp),
                'triggerPrice': float(tp),
                'orderType': 1,
                'triggerType': 1,
                'reduceOnly': True
            })
            results.append('TP set')
        if sl and float(sl) > 0:
            exchange.create_order(full_symbol, 'market', close_side, pos['contracts'], None, {
                'stopPrice': float(sl),
                'triggerPrice': float(sl),
                'orderType': 2,
                'triggerType': 1,
                'reduceOnly': True
            })
            results.append('SL set')
        return jsonify({'success': True, 'results': results})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/bulk-update-tpsl', methods=['POST'])
def bulk_update_tpsl():
    data = request.json
    api_key = data.get('apiKey')
    secret = data.get('secret')
    configs = data.get('configs', [])
    try:
        exchange = get_exchange(api_key, secret)
        exchange.load_markets()
        positions = exchange.fetch_positions()
        results = []
        errors = []
        for config in configs:
            try:
                symbol = config.get('symbol')
                full_symbol = f"{symbol}/USDT:USDT"
                side = config.get('side')
                expected_side = 'long' if side == 'buy' else 'short'
                pos = next((p for p in positions if (p['symbol'] == full_symbol or p['symbol'] == f"{symbol}/USDT" or p['symbol'] == f"{symbol}_USDT") and p.get('side') == expected_side), None)
                if pos and pos.get('contracts') and float(pos['contracts']) > 0:
                    close_side = 'sell' if side == 'buy' else 'buy'
                    open_orders = exchange.fetch_open_orders(full_symbol, params={'stop': True})
                    for o in open_orders:
                        if o['info'] and (o['info'].get('type') in ['3', '4']):
                            exchange.cancel_order(o['id'], full_symbol)
                    if config.get('takeProfit') and float(config['takeProfit']) > 0:
                        exchange.create_order(full_symbol, 'limit', close_side, pos['contracts'], float(config['takeProfit']), {
                            'stopPrice': float(config['takeProfit']),
                            'triggerPrice': float(config['takeProfit']),
                            'type': '3',
                            'reduceOnly': True
                        })
                    if config.get('stopLoss') and float(config['stopLoss']) > 0:
                        exchange.create_order(full_symbol, 'limit', close_side, pos['contracts'], float(config['stopLoss']), {
                            'stopPrice': float(config['stopLoss']),
                            'triggerPrice': float(config['stopLoss']),
                            'type': '4',
                            'reduceOnly': True
                        })
                    results.append({'symbol': symbol, 'success': True})
                    time.sleep(0.2)
            except Exception as e:
                errors.append({'symbol': config.get('symbol'), 'error': str(e)})
        return jsonify({'success': True, 'results': results, 'errors': errors})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

active_monitoring = False
monitor_config = None

def execute_close_all(api_key, secret):
    exchange = get_exchange(api_key, secret)
    exchange.load_markets()
    positions = exchange.fetch_positions()
    results = []
    errors = []
    for p in positions:
        if p.get('contracts') and float(p['contracts']) > 0:
            try:
                time.sleep(0.5)
                side = 'sell' if p['side'] == 'long' else 'buy'
                order = exchange.create_order(p['symbol'], 'market', side, p['contracts'], None, {'reduceOnly': True})
                results.append({'symbol': p['symbol'], 'order': order})
            except Exception as e:
                errors.append({'symbol': p['symbol'], 'error': str(e)})
    return results, errors

def monitoring_loop():
    global active_monitoring, monitor_config
    log_action("Monitoring loop started")
    # Wait a bit for orders to settle
    time.sleep(5)
    
    while active_monitoring and monitor_config:
        try:
            exchange = get_exchange(monitor_config['apiKey'], monitor_config['secret'])
            positions = exchange.fetch_positions()
            
            trigger = False
            for leader in monitor_config['leaders']:
                symbol = f"{leader['symbol']}/USDT:USDT"
                expected_side = 'long' if leader['side'] == 'buy' else 'short'
                
                # Find position
                pos = next((p for p in positions if p['symbol'] == symbol and p.get('side') == expected_side), None)
                
                # If position is gone or size is 0
                if not pos or not pos.get('contracts') or float(pos['contracts']) == 0:
                    log_action(f"Leader {symbol} position closed. Triggering Close All.")
                    trigger = True
                    break
            
            if trigger and active_monitoring:
                execute_close_all(monitor_config['apiKey'], monitor_config['secret'])
                active_monitoring = False
                break
        except Exception as e:
            # log_action(f"Monitor loop error: {str(e)}") # Keep logs clean, don't log every poll error
            pass
        time.sleep(3)

@app.route('/api/open-positions', methods=['POST'])
def open_positions():
    global active_monitoring, monitor_config
    data = request.json
    try:
        exchange = get_exchange(data['apiKey'], data['secret'])
        exchange.load_markets()
        results = []
        errors = []
        
        # Stop existing monitor
        active_monitoring = False
        time.sleep(0.5) 
        
        for order in data.get('orders', []):
            try:
                # Find the correct symbol mapping
                markets = exchange.markets
                market = markets.get(order['symbol']) or markets.get(order['symbol'] + '/USDT:USDT') or markets.get(order['symbol'] + '/USDT')
                if not market:
                    raise Exception(f"Symbol {order['symbol']} not found")
                
                symbol = market['symbol']
                
                # Set leverage
                if order.get('leverage'):
                    try:
                        pos_type = 1 if order['side'] == 'buy' else 2
                        exchange.set_leverage(int(order['leverage']), symbol, params={'openType': 2, 'positionType': pos_type})
                    except Exception as e:
                        log_action(f"Leverage set error for {symbol}: {e}")
                
                # Calculate amount
                amount_usdt = float(order['amount'])
                leverage = int(order.get('leverage', 1))
                position_usdt = amount_usdt * leverage
                
                if order.get('isUsdtAmount'):
                    ticker = exchange.fetch_ticker(symbol)
                    coin_amount = position_usdt / ticker['last']
                    contract_size = market.get('contractSize', 1)
                    amount = round(coin_amount / contract_size)
                    if amount < 1: raise Exception(f"Amount {amount} too low for {symbol}")
                else:
                    amount = float(order['amount'])
                
                time.sleep(0.2)
                
                # Prepare TP/SL params for atomic order creation
                params = {'reduceOnly': False}
                
                # Smart Validation: ensure TP/SL are in correct direction
                tp_val = float(order.get('takeProfit', 0))
                sl_val = float(order.get('stopLoss', 0))
                
                # If both provided, ensure they aren't reversed
                if tp_val > 0 and sl_val > 0:
                    if order['side'] == 'buy': # Long
                        if tp_val < sl_val: tp_val, sl_val = sl_val, tp_val
                    else: # Short
                        if tp_val > sl_val: tp_val, sl_val = sl_val, tp_val

                if tp_val > 0:
                    params['takeProfitPrice'] = tp_val
                    params['tpTriggerBy'] = 1 # Last Price
                if sl_val > 0:
                    params['stopLossPrice'] = sl_val
                    params['slTriggerBy'] = 1 # Last Price

                # Cancel existing trigger orders for this symbol first to avoid conflicts
                try:
                    open_orders = exchange.fetch_open_orders(symbol, params={'stop': True})
                    for o in open_orders:
                        if o['info'] and (o['info'].get('type') in ['1', '2', '3', '4']):
                            exchange.cancel_order(o['id'], symbol)
                except: pass

                # Create atomic market order with TP/SL
                created = exchange.create_order(symbol, 'market', order['side'], amount, None, params)
                results.append({'symbol': order['symbol'], 'order': created})
                
                # Small delay between different coins to avoid rate limits
                time.sleep(1.0)
                
            except Exception as e:
                log_action(f"Open position error for {order.get('symbol')}: {str(e)}")
                errors.append({'symbol': order.get('symbol'), 'error': str(e)})
        
        successful = [r['symbol'] for r in results]
        valid_leaders = [o for o in data.get('orders', []) if o.get('isLeader') and o['symbol'] in successful]
        
        if valid_leaders:
            monitor_config = {
                'apiKey': data['apiKey'], 
                'secret': data['secret'], 
                'leaders': [{'symbol': o['symbol'], 'side': o['side']} for o in valid_leaders]
            }
            active_monitoring = True
            threading.Thread(target=monitoring_loop, daemon=True).start()
            
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
    app.run(port=3001)
