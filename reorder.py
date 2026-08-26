import re

with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

main_start = html.find('<main class="dashboard">')
main_end = html.find('</main>')

main_content = html[main_start + len('<main class="dashboard">'):main_end]

sections_raw = main_content.split('<section ')

cards = {}
for s in sections_raw:
    if not s.strip(): continue
    s_full = '<section ' + s
    if 'id="sensorCard"' in s_full: cards['sensor'] = s_full
    elif 'id="batteryCard"' in s_full: cards['battery'] = s_full
    elif 'id="energyCard"' in s_full: cards['energy'] = s_full
    elif 'id="fanCard"' in s_full: cards['fan'] = s_full
    elif 'id="outsideLightCard"' in s_full: cards['outside'] = s_full
    elif 'id="insideLightCard"' in s_full: cards['inside'] = s_full
    else: cards['other'] = s_full

new_main = '\n'
new_main += cards.get('fan', '')
new_main += cards.get('outside', '')
new_main += cards.get('inside', '')
new_main += cards.get('sensor', '')
new_main += cards.get('battery', '')
new_main += cards.get('energy', '')

new_html = html[:main_start + len('<main class="dashboard">')] + new_main + '\n  ' + html[main_end:]

new_html = new_html.replace('font-size:0.9rem;', 'font-size:1.1rem; font-weight:bold;')
new_html = new_html.replace('font-size:0.8rem;', 'font-size:1rem;')
new_html = new_html.replace('font-size:0.85rem;', 'font-size:1rem;')
new_html = new_html.replace('padding:4px 8px;', 'padding:8px 12px;')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(new_html)

print('Reordered successfully!')
