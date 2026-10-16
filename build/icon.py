# Draws build/icon.svg (render it with: python3 build/icon.py build/icon.svg && rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png).
# Colours come from the app's palette (web/style.css, web/app.js).
import math, sys
size, gap, x0, y0 = 126, 18, 233, 330          # 4x4 pad grid spans x 233..791
right = x0 + 4 * size + 3 * gap                 # 791
lit = {(0,0):"#ff5a5f",(0,1):"#ff5a5f",(1,0):"#ff5a5f",(1,1):"#ff5a5f",(0,2):"#ffa630",(0,3):"#ffa630",
       (1,3):"#45b3ff",(2,3):"#45b3ff",(3,3):"#45b3ff",(3,0):"#7ee36b",(3,1):"#7ee36b"}
pads = []
for r in range(4):
    for c in range(4):
        x = x0 + c * (size + gap); y = y0 + r * (size + gap); col = lit.get((r, c))
        if col:
            pads.append(f'<rect x="{x-6}" y="{y-6}" width="{size+12}" height="{size+12}" rx="30" fill="{col}" opacity="0.55" filter="url(#glow)"/>')
            pads.append(f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="24" fill="{col}"/>')
            pads.append(f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="24" fill="url(#litSheen)"/>')
        else:
            pads.append(f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="24" fill="url(#rubber)" stroke="#4a4e52" stroke-width="3"/>')
# screen, left-aligned with the grid
sx, sy, sw, sh = x0, 170, 236, 124
pts = []
for i in range(0, sw - 40, 3):
    t = i / (sw - 40)
    a = (0.25 + 0.75 * math.exp(-((t - 0.22) / 0.12) ** 2) + 0.55 * math.exp(-((t - 0.62) / 0.1) ** 2)) * math.sin(i * 0.45) * 34
    pts.append(f"{sx + 20 + i},{sy + sh / 2 - a:.1f}")
# three knobs, right-aligned with the grid
kr, ky = 44, sy + sh / 2
kx = [right - kr - 2 * 92, right - kr - 92, right - kr]
knobs = ""
for cx, ang in zip(kx, (120, 70, 150)):
    ex, ey = cx + 30 * math.cos(math.radians(ang)), ky - 30 * math.sin(math.radians(ang))
    knobs += (f'<circle cx="{cx}" cy="{ky}" r="{kr}" fill="url(#knob)" stroke="#16181a" stroke-width="4"/>'
              f'<line x1="{cx}" y1="{ky}" x2="{ex:.1f}" y2="{ey:.1f}" stroke="#e8ebe6" stroke-width="7" stroke-linecap="round"/>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#36393c"/><stop offset="1" stop-color="#222426"/></linearGradient>
    <linearGradient id="rubber" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#43474a"/><stop offset="1" stop-color="#333639"/></linearGradient>
    <linearGradient id="litSheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.18"/></linearGradient>
    <radialGradient id="knob" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#5a5f63"/><stop offset="1" stop-color="#2a2c2e"/></radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.35"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#body)" filter="url(#shadow)"/>
  <rect x="104" y="104" width="816" height="816" rx="181" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="4"/>
  <rect x="{sx}" y="{sy}" width="{sw}" height="{sh}" rx="20" fill="#121314" stroke="#16181a" stroke-width="4"/>
  <polyline points="{" ".join(pts)}" fill="none" stroke="#3fd6c6" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
  {knobs}
  {"".join(pads)}
</svg>
'''
open(sys.argv[1], 'w').write(svg)
