    // Die Wetterdaten liefert der eigene Server (/api/weather/forecast);
    // der OpenWeatherMap-Schlüssel steht nur in dessen .env.
    let skyAnimOffset = 0;

    // --- Übernommene einfache buildIcon-Funktion aus PI_Wetter-mod.html ---
    function buildIcon(weather) {
      const w = weather.toLowerCase();
      const c = document.createElement('div');
      c.className = 'icon-wrapper';
      const sun = document.createElement('i');
      sun.className = 'fas fa-sun sun';
      c.appendChild(sun);
      if (/rain|drizzle|thunderstorm/.test(w)) {
        const cl = document.createElement('i');
        cl.className = 'fas fa-cloud cloud';
        c.appendChild(cl);
        const rn = document.createElement('i');
        rn.className = 'fas fa-cloud-showers-heavy rain';
        c.appendChild(rn);
      } else if (/cloud|overcast/.test(w)) {
        const cl = document.createElement('i');
        cl.className = 'fas fa-cloud cloud';
        c.appendChild(cl);
      }
      return c;
    }

    // Windrichtung als Pfeil und Text
    function windDir(deg) {
      const dirs = ['N','NO','O','SO','S','SW','W','NW','N'];
      const idx = Math.round(deg/45) % 8;
      return `<i class="fas fa-location-arrow" style="transform:rotate(${deg}deg)"></i> ${dirs[idx]}`;
    }

    // --- Neuer Hintergrund: echter Himmel und Erde (unverändert) ---
    let animState = {mode:"cold", clouds:[], sun:{}, rain:[], sunMoon:null, isRain:false};
    let starField = [];
    function setupStars() {
      const w = window.innerWidth, h = window.innerHeight;
      starField = [];
      for (let i = 0; i < 120; i++) {
        starField.push({
          x: Math.random() * w,
          y: Math.random() * h * 0.7,
          r: Math.random() * 1.1 + 0.3,
          a: 0.5 + Math.random() * 0.5
        });
      }
    }
    function getSkyColors(hour, isNight, mainDesc) {
      const desc = (mainDesc || '').toLowerCase();
      if (isNight) {
        return ["#1a233a", "#3a4660"];
      }
      if (desc.includes('rain') || desc.includes('drizzle') || desc.includes('thunderstorm')) {
        return ["#7e8fa3", "#cfd8df"];
      }
      if (desc.includes('overcast') || desc.includes('clouds') || desc.includes('cloud')) {
        return ["#bfc8d8", "#e3e8ef"];
      }
      if (desc.includes('few clouds') || desc.includes('scattered clouds') || desc.includes('partly')) {
        return ["#7ecaff", "#e0f6ff"];
      }
      return ["#47abff", "#a6d8ff"];
    }
    function blend(a, b, t) {
      const ah = a.replace('#','');
      const bh = b.replace('#','');
      const ar = parseInt(ah.substring(0,2),16), ag = parseInt(ah.substring(2,4),16), ab = parseInt(ah.substring(4,6),16);
      const br = parseInt(bh.substring(0,2),16), bg = parseInt(bh.substring(2,4),16), bb = parseInt(bh.substring(4,6),16);
      const rr = Math.round(ar + (br-ar)*t);
      const rg = Math.round(ag + (bg-ag)*t);
      const rb = Math.round(ab + (bb-ab)*t);
      return `#${rr.toString(16).padStart(2,'0')}${rg.toString(16).padStart(2,'0')}${rb.toString(16).padStart(2,'0')}`;
    }
    function drawBg(mode, isRain, sunMoon, mainDesc) {
      const canvas = document.getElementById('bg-anim');
      const ctx = canvas.getContext('2d');
      const w = window.innerWidth, h = window.innerHeight;
      canvas.width = w; canvas.height = h;

      const now = new Date();
      const hour = now.getHours() + now.getMinutes()/60;

      const isCloudy = mainDesc && (mainDesc.includes('cloud') || mainDesc.includes('overcast'));
      const [skyTop, skyBottom] = getSkyColors(hour, sunMoon && sunMoon.isNight, mainDesc);
      skyAnimOffset += 0.002;
      if (skyAnimOffset > 1) skyAnimOffset = 0;

      let grad = ctx.createLinearGradient(
        Math.sin(skyAnimOffset * 4 * Math.PI) * 620,
        Math.cos(skyAnimOffset * 4 * Math.PI) * 220,
        1, h
      );
      grad.addColorStop(0, skyTop);
      grad.addColorStop(1, skyBottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      if (sunMoon && !sunMoon.isNight) {
        const t = Math.max(0, Math.min(1, (hour - 6) / 14));
        const sunX = 80 + (w - 160) * t;
        const sunY = 70;
        let sunColor = "#FFD600";
        if (animState.avgTemp && animState.avgTemp > 30) sunColor = "#ff5722";

        ctx.save();
        ctx.globalAlpha = 0.97;
        ctx.beginPath();
        ctx.arc(sunX, sunY, 65, 0, 2 * Math.PI);
        ctx.fillStyle = sunColor;
        ctx.shadowColor = sunColor;
        ctx.shadowBlur = 120;
        ctx.fill();

        ctx.globalAlpha = 0.09;
        for (let i = 0; i < 120; i++) {
          ctx.save();
          ctx.translate(sunX, sunY);
          ctx.rotate((Math.PI * 2 * i) / 120);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, -260);
          ctx.lineWidth = 4;
          ctx.strokeStyle = sunColor;
          ctx.shadowColor = sunColor;
          ctx.shadowBlur = 40;
          ctx.stroke();
          ctx.restore();
        }

        ctx.globalAlpha = 0.07;
        for (let i = 0; i < 240; i++) {
          ctx.save();
          ctx.translate(sunX, sunY);
          ctx.rotate((Math.PI * 2 * i) / 240);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          const len = 220 + Math.sin(i * 7) * 40 + Math.random() * 18;
          ctx.lineTo(0, -len);
          ctx.lineWidth = 1.5 + Math.random() * 1.5;
          ctx.strokeStyle = sunColor;
          ctx.shadowColor = sunColor;
          ctx.shadowBlur = 28;
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = 0.07;
        const rays = 240;
        for (let i = 0; i < rays; i++) {
          ctx.save();
          ctx.translate(sunX, sunY);
          ctx.rotate((Math.PI * 2 * i) / rays);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          const len = 180 + Math.random() * 90 + Math.pow(Math.sin((Math.PI * i) / rays), 2) * 80;
          ctx.lineTo(0, -len);
          ctx.lineWidth = 0.7 + Math.random() * 1.2;
          ctx.strokeStyle = sunColor;
          ctx.shadowColor = sunColor;
          ctx.shadowBlur = 18 + Math.pow(Math.sin((Math.PI * i) / rays), 2) * 40;
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }

      if (sunMoon && sunMoon.isNight) {
        const moonX = w * 0.8;
        const moonY = h * 0.18;
        ctx.save();
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(moonX, moonY, 50, 0, 2 * Math.PI);
        ctx.fillStyle = "#d6d7db";
        ctx.shadowColor = "#b0b4bb";
        ctx.shadowBlur = 60;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(moonX + 18, moonY - 10, 50, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(26,35,64,0.95)`;
        ctx.fill();
        ctx.restore();
      }

      animState.clouds.forEach(cloud => {
        ctx.save();
        ctx.globalAlpha = 0.82;
        ctx.beginPath();
        ctx.arc(cloud.x, cloud.y, cloud.r * 0.45, 0, 2 * Math.PI);
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "#b0c4d6";
        ctx.shadowBlur = 32;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cloud.x - cloud.r * 0.35, cloud.y + cloud.r * 0.05, cloud.r * 0.32, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cloud.x + cloud.r * 0.38, cloud.y + cloud.r * 0.08, cloud.r * 0.28, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cloud.x - cloud.r * 0.18, cloud.y - cloud.r * 0.22, cloud.r * 0.22, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cloud.x + cloud.r * 0.18, cloud.y - cloud.r * 0.22, cloud.r * 0.18, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cloud.x, cloud.y - cloud.r * 0.28, cloud.r * 0.13, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      });

      animState.clouds.forEach(cloud => {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.filter = 'blur(12px)';
        ctx.beginPath();
        ctx.ellipse(cloud.x, cloud.y, cloud.r * 1.1, cloud.r * 0.55, 0, 0, 2 * Math.PI);
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "#b0bec5";
        ctx.shadowBlur = 40;
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cloud.x - cloud.r * 0.5, cloud.y - cloud.r * 0.18, cloud.r * 0.6, cloud.r * 0.32, 0, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cloud.x + cloud.r * 0.5, cloud.y - cloud.r * 0.12, cloud.r * 0.5, cloud.r * 0.28, 0, 0, 2 * Math.PI);
        ctx.fill();
        ctx.filter = 'none';
        ctx.restore();
      });

      if (isRain) {
        ctx.save();
        ctx.strokeStyle = "#2196f3";
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 4;
        animState.rain.forEach(drop => {
          ctx.beginPath();
          ctx.moveTo(drop.x, drop.y);
          ctx.lineTo(drop.x, drop.y + drop.l * 2);
          ctx.stroke();
        });
        ctx.restore();
      }
      if (animState.isSnow) {
        ctx.save();
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = "#fff";
        animState.snow.forEach(flake => {
          ctx.beginPath();
          ctx.arc(flake.x, flake.y, flake.r, 0, 2 * Math.PI);
          ctx.fill();
        });
        ctx.restore();
      }

      if (sunMoon && sunMoon.isNight) {
        if (starField.length === 0 || starField[0].x > w) setupStars();
        ctx.save();
        starField.forEach(star => {
          ctx.globalAlpha = star.a;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, 2 * Math.PI);
          ctx.fillStyle = "#fff";
          ctx.shadowColor = "#fff";
          ctx.shadowBlur = 10;
          ctx.fill();
        });
        ctx.restore();
      }

      if (mainDesc && (mainDesc.includes('cloud') || mainDesc.includes('overcast'))) {
        animState.clouds.forEach(cloud => {
          ctx.save();
          ctx.globalAlpha = 0.7;
          ctx.filter = 'blur(18px)';
          ctx.beginPath();
          ctx.ellipse(cloud.x, cloud.y, cloud.r * 1.2, cloud.r * 0.6, 0, 0, 2 * Math.PI);
          ctx.fillStyle = "#f5f7fa";
          ctx.shadowColor = "#b0bec5";
          ctx.shadowBlur = 60;
          ctx.fill();
          ctx.filter = 'none';
          ctx.restore();
        });
      }
    }

    function animateBg() {
      const w = window.innerWidth, h = window.innerHeight;
      animState.clouds.forEach(cloud => {
        cloud.x += cloud.speed * 1.5;
        if (cloud.x - cloud.r * 1.5 > w) cloud.x = -cloud.r * 1.5;
      });
      animState.rain.forEach(drop => {
        drop.y += drop.v * 1.5;
        if (drop.y > h) {
          drop.y = Math.random() * -80;
          drop.x = Math.random() * w;
        }
      });
      animState.snow.forEach(flake => {
        flake.y += flake.v;
        flake.x += Math.sin(flake.y / 30) * 0.7;
        if (flake.y > h) {
          flake.y = Math.random() * -40;
          flake.x = Math.random() * w;
        }
      });
      drawBg(animState.mode, animState.isRain, animState.sunMoon, animState.mainDesc);
      requestAnimationFrame(animateBg);
    }

    function setupBg(mode, isRain, sunMoon, isSnow) {
      const w = window.innerWidth, h = window.innerHeight;
      animState.clouds = [];
      if (mode === "mild" || mode === "rain" || mode === "cold" || mode === "snow") {
        const cloudCount = 3 + Math.floor(Math.random() * 2);
        const segment = w / (cloudCount + 1);
        for (let i = 0; i < cloudCount; i++) {
          const baseX = segment * (i + 1);
          animState.clouds.push({
            x: baseX + (Math.random() - 0.5) * segment * 0.18,
            y: h * (0.10 + Math.random() * 0.30),
            r: 140 + Math.random() * 60,
            speed: 0.3 + Math.random() * 0.4
          });
        }
      }
      animState.rain = [];
      animState.isRain = isRain;
      if (isRain) {
        for (let i = 0; i < 70; i++) {
          animState.rain.push({
            x: Math.random() * w,
            y: Math.random() * h,
            l: 24 + Math.random() * 18,
            v: 4 + Math.random() * 3
          });
        }
      }
      animState.snow = [];
      animState.isSnow = isSnow;
      if (isSnow) {
        for (let i = 0; i < 60; i++) {
          animState.snow.push({
            x: Math.random() * w,
            y: Math.random() * h,
            r: 2 + Math.random() * 3,
            v: 1 + Math.random() * 1.5
          });
        }
      }
      animState.mode = mode;
      animState.sunMoon = sunMoon;
    }

    function updateEarthShadow(sunMoon) {
      let angle = 90 + (sunMoon && !sunMoon.isNight ? sunMoon.pos * 180 : 270);
      document.getElementById('earth-css').style.setProperty('--shadow-angle', angle + 'deg');
    }

    // Daten holen & anzeigen
    fetch('/api/weather/forecast', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject('Wetterdaten nicht verfügbar'))
      .then(data => {
        const byDay = {};
        data.list.forEach(item => {
          const day = new Date(item.dt*1000).toISOString().slice(0,10);
          (byDay[day] = byDay[day]||[]).push(item);
        });
        const cont = document.getElementById('forecast');
        cont.innerHTML = '';
        let mainDesc = '';
        let avgTemp = 10;
        let isRain = false;
        let isSnow = false;
        let sys = data.city && data.city.sunrise && data.city.sunset ? data.city : null;
        let sunrise = sys ? sys.sunrise : 21600;
        let sunset  = sys ? sys.sunset  : 72000;

        Object.keys(byDay).slice(0,5).forEach((day, idx) => {
          const items = byDay[day];
          const temps = items.flatMap(i=>[i.main.temp_max,i.main.temp_min]);
          const max = Math.max(...temps);
          const min = Math.min(...temps);
          const avg = (max+min)/2;
          const iconItem = items.find(i=>new Date(i.dt*1000).getHours()===12) || items[0];
          const desc = iconItem.weather[0].main;
          const d = new Date(day);

          if(idx===0) {
            mainDesc = desc.toLowerCase();
            avgTemp = avg;
            isRain = mainDesc.includes('rain')||mainDesc.includes('drizzle')||mainDesc.includes('thunderstorm');
            isSnow = mainDesc.includes('snow');
            animState.avgTemp = avg;
            animState.mainDesc = mainDesc;
          }

          const wind = Math.round(items.reduce((a,b)=>a+b.wind.speed,0)/items.length*10)/10;
          const windDeg = Math.round(items.reduce((a,b)=>a+b.wind.deg,0)/items.length);
          const hum = Math.round(items.reduce((a,b)=>a+b.main.humidity,0)/items.length);
          const rain = Math.round(items.reduce((a,b)=>a+(b.rain?.['3h']||0),0)*10)/10;

          const card = document.createElement('div');
          card.className = 'day';
          if (idx === 0) card.classList.add('today');

          // Hintergrund nun immer hell-himmelblau:
          card.style.background = 'var(--box-bg)';

          const h2 = document.createElement('h2');
          h2.textContent = d.toLocaleDateString('de-DE',{weekday:'short',day:'numeric',month:'numeric'});
          card.appendChild(h2);

          let iconElem = buildIcon(desc);
          card.appendChild(iconElem);

          const tp = document.createElement('div');
          tp.className = 'temp';
          tp.textContent = `${Math.round(max)}°	/	${Math.round(min)}°`;
          card.appendChild(tp);

          const dc = document.createElement('div');
          dc.className = 'desc';
          dc.textContent = iconItem.weather[0].description;
          card.appendChild(dc);

          const det = document.createElement('div');
          det.className = 'details';
          det.innerHTML = `
            <span><i class="fas fa-wind"></i> Wind: ${wind} m/s ${windDir(windDeg)}</span>
            <span><i class="fas fa-tint"></i> Feuchte: ${hum}%</span>
            <span><i class="fas fa-cloud-rain"></i> Regen: ${rain} mm</span>
          `;
          card.appendChild(det);

          cont.appendChild(card);
        });

        let mode = "mild";
        if(isRain) mode = "rain";
        else if(avgTemp <= 5) mode = "cold";
        else if(avgTemp <= 15) mode = "mild";
        else if(avgTemp <= 25) mode = "warm";
        else mode = "hot";

        function getSunMoonState(sunrise, sunset) {
          const now = new Date();
          const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
          const sunriseDate = new Date(sunrise * 1000);
          const sunsetDate = new Date(sunset * 1000);
          const sunriseSec = sunriseDate.getHours()*3600 + sunriseDate.getMinutes()*60 + sunriseDate.getSeconds();
          const sunsetSec  = sunsetDate.getHours()*3600 + sunsetDate.getMinutes()*60 + sunsetDate.getSeconds();

          if (nowSec < sunriseSec || nowSec > sunsetSec) {
            const nightLen = (86400 - sunsetSec) + sunriseSec;
            let t = nowSec > sunsetSec
              ? (nowSec - sunsetSec) / nightLen
              : (nowSec + (86400 - sunsetSec)) / nightLen;
            return { isNight: true, pos: t };
          } else {
            const dayLen = sunsetSec - sunriseSec;
            const t = (nowSec - sunriseSec) / dayLen;
            return { isNight: false, pos: t };
          }
        }

        const sunMoon = getSunMoonState(sunrise, sunset);
        setupBg(mode, isRain, sunMoon, isSnow);
        updateEarthShadow(sunMoon);
        animateBg();
      })
      .catch(err => {
        console.error(err);
        document.getElementById('forecast').textContent = 'Fehler beim Laden des Wetters.';
      });

    window.addEventListener('resize', () => {
      setupBg(animState.mode, animState.isRain, animState.sunMoon, animState.isSnow);
      if (animState.sunMoon && animState.sunMoon.isNight) setupStars();
    });

    function updateBoxTextColor() {
      const hour = new Date().getHours();
      const isDay = hour >= 7 && hour <= 19;
      document.documentElement.style.setProperty(
        '--dynamic-text',
        isDay ? '#222' : '#fff'
      );
    }
    setInterval(updateBoxTextColor, 60000);
    updateBoxTextColor();
