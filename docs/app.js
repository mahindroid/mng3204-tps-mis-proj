(function () {
  var C = window.APP_CONFIG || {};
  var URL = C.APPS_SCRIPT_URL || "";
  var SESSION_KEY = "tps-session";
  var NAV = [{route:"dashboard",label:"Dashboard",permission:"dashboard"},{route:"reports",label:"Sales Report",permission:"reports"},{route:"pos",label:"POS",permission:"pos"},{route:"inventory",label:"Inventory",permission:"inventory"}];
  var timer = null;
  var posClockTimer = null;
  var errorTimer = null;
  var state = { session:loadSession(), inventory:[], dashboard:null, report:{filters:{periodType:"all",date:"",employee:"",product:""},data:null,loading:false}, status:"loading", message:"", dataLoaded:false };
  function loadSession(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||"null");}catch(e){return null;}}
  function saveSession(v){state.session=v;localStorage.setItem(SESSION_KEY,JSON.stringify(v));}
  function clearSession(){state.session=null;localStorage.removeItem(SESSION_KEY);stopTimer(); state.message=""; state.dataLoaded=false;}
  function clearDelayedError(){if(errorTimer){window.clearTimeout(errorTimer); errorTimer=null;}}
  function showDelayedError(message,fn){clearDelayedError(); errorTimer=window.setTimeout(function(){errorTimer=null; state.message=message; if(fn) fn(); render();},500);}
  function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function money(v){return "$"+Math.round(Number(v||0)).toLocaleString(undefined,{maximumFractionDigits:0});}
  function todayKey(){var d=new Date(); return [d.getFullYear(),("0"+(d.getMonth()+1)).slice(-2),("0"+d.getDate()).slice(-2)].join("-");}
  function offsetDateKey(dateKey,days){var parts=String(dateKey||todayKey()).split("-"), date=new Date(Number(parts[0]||0),Number(parts[1]||1)-1,Number(parts[2]||1)); if(isNaN(date.getTime())) return todayKey(); date.setDate(date.getDate()+Number(days||0)); return [date.getFullYear(),("0"+(date.getMonth()+1)).slice(-2),("0"+date.getDate()).slice(-2)].join("-");}
  function dateKeyFromValue(value){var text=String(value||"").trim(); if(!text) return ""; if(/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10); var date=new Date(text); if(isNaN(date.getTime())) return ""; return [date.getFullYear(),("0"+(date.getMonth()+1)).slice(-2),("0"+date.getDate()).slice(-2)].join("-");}
  function trendLabel(dateKey){var date=new Date(String(dateKey||"") + "T00:00:00"); if(isNaN(date.getTime())) return dateKey||""; return date.toLocaleDateString(undefined,{month:"short",day:"numeric"});}
  function scopeDateLabel(dateKey){var date=new Date(String(dateKey||"") + "T00:00:00"); if(isNaN(date.getTime())) return dateKey||""; return date.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});}
  function inventoryItemName(sku,fallback){var key=String(sku||"").trim(), item=(state.inventory||[]).filter(function(row){return String(row&&row.sku||"").trim()===key;})[0], name=String(item&&item.name||fallback||key||"Unknown Item").trim(); return name||"Unknown Item";}
  function route(){return window.location.hash.replace(/^#\/?/,"")||(state.session?defaultRouteForRole(state.session.role):"dashboard");}
  function go(v){window.location.hash="#"+v;}
  function req(url,options){return fetch(url,options||{}).catch(function(err){throw new Error("Fetch failed for "+url+" | "+(err&&err.message?err.message:String(err)));}).then(function(r){if(!r.ok)throw new Error("Request failed: "+r.status+" | "+url);return r.json();}).then(function(p){if(p&&p.ok===false)throw new Error((p.error||"Backend request failed.")+" | "+url);return p;});}
  function post(action,payload){return req(URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action:action,payload:payload||{}})});}
  function fetchInventory(){return req(URL+"?action=inventory");}
  function fetchDashboard(){return req(URL+"?action=dashboard");}
  function fetchReport(filters){var params=[], source=filters||{}; ["periodType","date","employee","product"].forEach(function(key){if(source[key]) params.push(key+"="+encodeURIComponent(source[key]));}); return req(URL+"?action=report"+(params.length?"&"+params.join("&"):""));}
  function loginUser(userId){return post("loginUser",{userId:userId});}
  function submitSale(payload){return post("sale",payload);}
  function health(){if(!URL) throw new Error("Add APPS_SCRIPT_URL in docs/config.js."); return req(URL+"?action=health");}
  function salesChange(todaySales,previousSales){var current=Number(todaySales||0), previous=Number(previousSales||0), changePercent=previous>0?Math.round(((current-previous)/previous)*100):(current>0?100:0); return {percent:Math.abs(changePercent),direction:current>=previous?"up":"down",previousValue:previous};}
  function hydrateDashboard(dashboard){var next=dashboard||null; if(!next) return Promise.resolve(next); if(next.totalSalesChange) return Promise.resolve(next); return fetchReport({periodType:"date",date:offsetDateKey(next.reportDate||todayKey(),-1)}).then(function(r){next.totalSalesChange=salesChange(next.totalSalesValue,r&&r.data&&r.data.totalSalesValue); return next;}).catch(function(){next.totalSalesChange=salesChange(next.totalSalesValue,0); return next;});}
  function reportTrendAnchor(report,filters){var selectedDate=dateKeyFromValue(filters&&filters.date); if(selectedDate) return selectedDate; var recent=(report&&report.recentTransactions||[]).map(function(item){return dateKeyFromValue(item&&item.saleDatetime);}).filter(Boolean)[0]; return recent||todayKey();}
  function hydrateReport(report,filters){
    var next=report||null;
    if(!next) return Promise.resolve(next);
    if(next.weeklyAggregate) return Promise.resolve(next);

    var activeFilters=filters||{},
      anchorDate=reportTrendAnchor(next,activeFilters),
      employee=String(activeFilters.employee||""),
      product=String(activeFilters.product||""),
      startDate=offsetDateKey(anchorDate,-6),
      dates=[],
      parts=[],
      totalSales=0,
      totalTransactions=0,
      totalItems=0,
      quantitySold=0,
      salesByEmployee={},
      paymentMix={},
      quantityByProduct={},
      recentTransactions=[],
      quantityProductOrder=0,
      inventoryRows=(state.inventory||[]).filter(function(row){
        var sku=String(row&&row.sku||"").trim(),
          name=String(row&&row.name||"").trim();
        if(!sku && !name) return false;
        return !product || sku===product || name===product;
      });

    inventoryRows.forEach(function(row){
      var sku=String(row&&row.sku||"").trim(),
        resolvedName=inventoryItemName(sku,row&&row.name),
        key=sku||resolvedName;
      if(!key) return;
      quantityByProduct[key]={sku:sku,name:resolvedName,label:sku?sku+" - "+resolvedName:resolvedName,qty:0,sales:0,order:quantityProductOrder++};
    });

    for(var offset=-6;offset<=0;offset+=1){
      dates.push(offsetDateKey(anchorDate,offset));
    }

    return Promise.all(dates.map(function(dateKey){
      return fetchReport({periodType:"date",date:dateKey,employee:employee,product:product}).then(function(r){
        return {date:dateKey,data:r&&r.data||null};
      }).catch(function(){
        return {date:dateKey,data:null};
      });
    })).then(function(days){
      var trend=days.map(function(entry){
          var day=entry.data||{}, value=Number(day.totalSalesValue||0);
          totalSales+=value;
          totalTransactions+=Number(day.totalTransactions||0);
          totalItems+=Number(day.totalItemsSold||0);
          quantitySold+=Number(day.quantitySold||0);

          (day.salesByEmployee||[]).forEach(function(row){
            var label=String(row&&row.label||"").trim();
            if(!label) return;
            if(!salesByEmployee[label]) salesByEmployee[label]={label:label,value:0};
            salesByEmployee[label].value+=Number(row&&row.value||0);
          });

          (day.paymentMix||[]).forEach(function(row){
            var label=String(row&&row.label||"").trim();
            if(!label) return;
            if(!paymentMix[label]) paymentMix[label]={label:label,value:0,count:0};
            paymentMix[label].value+=Number(row&&row.value||0);
            paymentMix[label].count+=Number(row&&row.count||0);
          });

          (day.quantityByProduct||[]).forEach(function(row){
            var key=String(row&&row.sku||row&&row.label||row&&row.name||"").trim(),
              sku=String(row&&row.sku||"").trim(),
              fallbackName=String(row&&row.name||row&&row.label||"Unknown Item"),
              resolvedName=inventoryItemName(sku,fallbackName);
            if(!key) key=sku||resolvedName;
            if(!key) return;
            if(!quantityByProduct[key]){
              quantityByProduct[key]={sku:sku,name:resolvedName,label:sku?sku+" - "+resolvedName:resolvedName,qty:0,sales:0,order:quantityProductOrder++};
            }
            quantityByProduct[key].qty+=Number(row&&row.qty||0);
            quantityByProduct[key].sales+=Number(row&&row.sales||0);
          });

          recentTransactions=recentTransactions.concat(day.recentTransactions||[]);
          return {date:entry.date,label:trendLabel(entry.date),value:value};
        }),
        salesRows=Object.keys(salesByEmployee).map(function(key){
          return salesByEmployee[key];
        }).sort(function(a,b){
          if(Number(b.value||0)!==Number(a.value||0)) return Number(b.value||0)-Number(a.value||0);
          return String(a.label||"").localeCompare(String(b.label||""));
        }),
        paymentRows=Object.keys(paymentMix).map(function(key){
          return paymentMix[key];
        }).sort(function(a,b){
          if(Number(b.value||0)!==Number(a.value||0)) return Number(b.value||0)-Number(a.value||0);
          return String(a.label||"").localeCompare(String(b.label||""));
        }),
        productRows=Object.keys(quantityByProduct).map(function(key){
          var row=quantityByProduct[key], resolvedName=inventoryItemName(row&&row.sku,row&&row.name);
          return {sku:String(row&&row.sku||""),name:resolvedName,label:row&&row.sku?String(row.sku)+" - "+resolvedName:resolvedName,qty:Number(row&&row.qty||0),sales:Number(row&&row.sales||0),order:Number(row&&row.order||0)};
        }),
        rankedProductRows=productRows.slice().sort(function(a,b){
          if(Number(b.qty||0)!==Number(a.qty||0)) return Number(b.qty||0)-Number(a.qty||0);
          return String(a.name||"").localeCompare(String(b.name||""));
        }),
        chartProductRows=productRows.slice().sort(function(a,b){
          if(Number(a.order||0)!==Number(b.order||0)) return Number(a.order||0)-Number(b.order||0);
          return String(a.sku||a.name||"").localeCompare(String(b.sku||b.name||""));
        }),
        mostSold=rankedProductRows.filter(function(row){
          return Number(row.qty||0)>0;
        })[0]||null;

      parts.push("Sale data for "+scopeDateLabel(startDate)+" - "+scopeDateLabel(anchorDate));
      if(employee) parts.push("Employee: "+employee);
      if(product) parts.push("Product: "+product);
      next.reportDate=anchorDate;
      next.reportScope=parts.join(" | ");
      next.totalSalesValue=Math.round(totalSales);
      next.totalTransactions=totalTransactions;
      next.totalItemsSold=totalItems;
      next.quantitySold=quantitySold;
      next.averageBasket=totalTransactions?Math.round(totalSales/totalTransactions):0;
      next.mostSoldItem=mostSold?{sku:mostSold.sku||"",name:mostSold.name||"Unknown Item",qty:Number(mostSold.qty||0)}:null;
      next.salesByEmployee=salesRows;
      next.paymentMix=paymentRows;
      next.quantityByProduct=chartProductRows;
      next.salesTrend=trend;
      next.recentTransactions=recentTransactions.sort(function(a,b){
        return String(b&&b.saleDatetime||"").localeCompare(String(a&&a.saleDatetime||""));
      }).slice(0,6);
      next.weeklyAggregate=true;
      return next;
    });
  }
  function refreshData(){return fetchInventory().then(function(r){state.inventory=r.data||[]; return Promise.all([fetchDashboard().then(function(r2){return hydrateDashboard(r2.data||null);}).then(function(d){state.dashboard=d;}),fetchReport(state.report.filters).then(function(r2){return hydrateReport(r2.data||null,state.report.filters);}).then(function(d){state.report.data=d;})]);}).then(function(){state.dataLoaded=true;});}
  function startTimer(){stopTimer(); timer=window.setInterval(function(){if(state.session&&route()==="dashboard")fetchDashboard().then(function(r){return hydrateDashboard(r.data||null);}).then(function(d){state.dashboard=d; render();});},10000);}
  function stopTimer(){if(timer){window.clearInterval(timer); timer=null;}}
  function posPillText(d){return 'Date: '+esc((d&&d.reportDate)||todayKey())+' | Time: '+esc(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));}
  function startPosClock(){stopPosClock(); posClockTimer=window.setInterval(function(){var pill=document.getElementById("pos-date-pill"); if(pill&&route()==="pos") pill.innerHTML=posPillText(state.dashboard||{});},60000);}
  function stopPosClock(){if(posClockTimer){window.clearInterval(posClockTimer); posClockTimer=null;}}
  function toolbar(){return state.message?'<div class="card warning">'+esc(state.message)+'</div>':"";}
  function defaultRouteForRole(role){return String(role||"").toLowerCase()==="cashier"?"pos":"dashboard";}
  function shell(content){var current=route().split("/")[0], nav=NAV.map(function(i){return '<a class="nav-link'+(current===i.route?' active':'')+'" href="#'+i.route+'">'+esc(i.label)+'</a>';}).join(""); return '<div class="app-shell"><aside class="sidebar"><div class="brand brand-only"><img class="brand-logo" src="assets/logo.png" alt="Signature Scents logo"></div><div class="user-badge"><strong>'+esc(state.session.fullName)+'</strong><p>'+esc(state.session.role)+'</p></div><nav class="nav">'+nav+'</nav><button class="button ghost" data-action="logout">Log out</button></aside><main class="content">'+toolbar()+content+'</main></div>';}
  function loginView(){return '<div class="auth-shell"><div class="auth-card"><div class="brand auth-brand-stack"><img class="brand-logo" src="assets/logo.png" alt="Signature Scents logo"><p class="auth-title">Transaction Processing System</p></div><form class="form-grid" id="login-form"><input name="userId" placeholder="Enter User ID" aria-label="Enter User ID" required><button class="button primary" type="submit"><span class="button-label">Sign in</span><span class="button-dots" aria-hidden="true"><span></span><span></span><span></span></span></button><p class="error" id="login-message" hidden></p></form></div></div>';}
  function setupView(){return '<div class="auth-shell"><div class="auth-card"><div class="brand"><img class="brand-logo" src="assets/logo.png" alt="Signature Scents logo"><div><h1>Google Sheets Backend</h1><p>Backend configuration required</p></div></div><p class="warning">'+esc(state.message||'Add a valid Google Apps Script web app URL in docs/config.js.')+'</p><div class="demo-note"><strong>Main database:</strong> this app now uses Google Sheets as the database backend.</div><div class="inline-actions"><button class="button primary" data-action="retry-data">Retry Connection</button></div></div></div>';}
  function dataUnavailableView(){return shell('<div class="page-header"><div class="page-intro"><h2>Database Data Unavailable</h2><p class="muted">The app could not load inventory and dashboard data from the Google Sheets backend.</p></div></div><div class="card"><p class="warning">'+esc(state.message||"Could not load backend data.")+'</p><p class="muted">Check the Apps Script deployment, confirm the sheet was initialized, and try again.</p><button class="button primary" data-action="retry-data">Retry Loading Data</button></div>');}
  function kpi(label,value,className,meta){return '<div class="card kpi-card'+(className?' '+className:'')+(meta?' has-meta':'')+'"><p class="muted">'+esc(label)+'</p><div class="kpi-value-row"><h3>'+esc(value)+'</h3>'+(meta||"")+'</div></div>';}
  function salesChangeMeta(change){if(!change) return ""; var arrow=change.direction==="down"?"&darr;":"&uarr;", cls=change.direction==="down"?"kpi-trend negative":"kpi-trend positive"; return '<p class="'+cls+'"><span class="kpi-trend-arrow">'+arrow+'</span><span>'+esc(String(change.percent||0))+'% vs previous day</span></p>';}
  function pieChart(title,data,moneyMode){var rows=(data||[]).filter(function(item){return Number(item&&item.value||0)>0;}).slice(0,6), total=rows.reduce(function(sum,item){return sum+Number(item.value||0);},0), colors=["var(--chart-1)","var(--chart-2)","var(--chart-3)","var(--chart-4)","var(--chart-5)","var(--chart-6)"]; if(!rows.length||!total){return '<div class="card"><h3>'+esc(title)+'</h3><p class="muted">No data for this filter yet.</p></div>';} var angle=0, gradient=rows.map(function(item,index){var next=angle+(Number(item.value||0)/total)*360, part=colors[index%colors.length]+' '+angle+'deg '+next+'deg'; angle=next; return part;}).join(", "), legend=rows.map(function(item,index){return '<li><span class="chart-swatch" style="--swatch-color:'+colors[index%colors.length]+'"></span><span>'+esc(item.label)+'</span><strong>'+esc(moneyMode?money(item.value):String(Math.round(Number(item.value||0))).toLocaleString())+'</strong></li>';}).join(""); return '<div class="card chart-card"><h3>'+esc(title)+'</h3><div class="pie-layout"><div class="pie-chart" style="--pie-gradient:'+gradient+'"></div><ul class="chart-legend">'+legend+'</ul></div></div>';}
  function donutChart(title,data,moneyMode,centerLabel){var rows=(data||[]).filter(function(item){return Number(item&&item.value||0)>0;}).slice(0,6), total=rows.reduce(function(sum,item){return sum+Number(item.value||0);},0), colors=["var(--chart-4)","#bcc4d6","var(--chart-2)","var(--chart-1)","var(--chart-5)","var(--chart-6)"], size=220, cx=110, cy=110, radius=74, circumference=2*Math.PI*radius, traveled=0, minValue=rows.reduce(function(low,item){var value=Number(item&&item.value||0); return low===null||value<low?value:low;},null), minCount=rows.filter(function(item){return Number(item&&item.value||0)===minValue;}).length, centerText=String(centerLabel==null?"Total":centerLabel).trim(); if(!rows.length||!total){return '<div class="card"><h3>'+esc(title)+'</h3><p class="muted">No data for this filter yet.</p></div>';} var segments=rows.map(function(item,index){var value=Number(item.value||0), portion=value/total, percent=Math.round(portion*100), isLower=rows.length>1&&minCount===1&&value===minValue, arc=Math.max(0,portion*circumference), start=traveled, midAngle=((start+(portion*circumference/2))/circumference)*360-90, radians=midAngle*(Math.PI/180), labelRadius=isLower?radius+8:radius, segment={item:item,color:colors[index%colors.length],arc:arc.toFixed(2),offset:(-start).toFixed(2),percent:percent,ringWidth:isLower?56:44,x:Math.round(Math.cos(radians)*labelRadius),y:Math.round(Math.sin(radians)*labelRadius)}; traveled+=portion*circumference; return segment;}); return '<div class="card chart-card donut-card"><h3>'+esc(title)+'</h3><div class="donut-layout"><ul class="donut-legend">'+segments.map(function(segment){return '<li><span class="chart-swatch" style="--swatch-color:'+segment.color+'"></span><span>'+esc(segment.item.label)+'</span></li>';}).join("")+'</ul><div class="donut-chart-wrap"><div class="donut-chart"><svg class="donut-svg" viewBox="0 0 '+size+' '+size+'" aria-hidden="true">'+segments.map(function(segment){return '<circle class="donut-ring-segment" cx="'+cx+'" cy="'+cy+'" r="'+radius+'" style="stroke:'+segment.color+';stroke-dasharray:'+segment.arc+' '+circumference.toFixed(2)+';stroke-dashoffset:'+segment.offset+';stroke-width:'+segment.ringWidth+'"></circle>';}).join("")+'</svg><div class="donut-center'+(centerText?'':' is-value-only')+'"><strong>'+esc(moneyMode?money(total):String(Math.round(total)).toLocaleString())+'</strong>'+(centerText?'<span>'+esc(centerText)+'</span>':'')+'</div>'+segments.map(function(segment){return '<span class="donut-slice-label" style="--x:'+segment.x+'px;--y:'+segment.y+'px">'+esc(String(segment.percent))+'%</span>';}).join("")+'</div></div></div></div>';}
  function barChart(title,data,valueKey,labelKey,formatFn){var rows=(data||[]).filter(function(item){return Number(item&&item[valueKey]||0)>0;}).slice(0,8), max=rows.reduce(function(high,item){return Math.max(high,Number(item[valueKey]||0));},0); if(!rows.length||!max){return '<div class="card"><h3>'+esc(title)+'</h3><p class="muted">No data for this filter yet.</p></div>';} return '<div class="card chart-card"><h3>'+esc(title)+'</h3><div class="bar-chart">'+rows.map(function(item){var value=Number(item[valueKey]||0), width=Math.max(8,(value/max)*100); return '<div class="bar-row"><div class="bar-meta"><span>'+esc(item[labelKey])+'</span><strong>'+esc(formatFn(value))+'</strong></div><div class="bar-track"><div class="bar-fill" style="width:'+width+'%"></div></div></div>';}).join("")+'</div></div>';}
  function quantityLineChart(title,data){var rows=(data||[]), max=rows.reduce(function(high,item){return Math.max(high,Number(item&&item.qty||0));},0), scaleMax=max>0?max:1, chartWidth=448, chartLeft=84, chartRight=18, chartTop=18, chartBottom=42, plotWidth=chartWidth-chartLeft-chartRight, plotHeight=Math.max(140,(rows.length-1)*40), chartHeight=chartTop+plotHeight+chartBottom; if(!rows.length){return '<div class="card"><h3>'+esc(title)+'</h3><p class="muted">No data for this filter yet.</p></div>';} function xFor(value){return (Number(value||0)/scaleMax)*plotWidth;} function yFor(index){return rows.length===1?(plotHeight/2):(plotHeight-((plotHeight/(rows.length-1))*index));} var points=rows.map(function(row,index){return {x:xFor(row.qty),y:yFor(index),label:String(row&&row.sku||row&&row.name||row&&row.label||""),value:Number(row&&row.qty||0)};}), xTicks=(max>0?[0,0.25,0.5,0.75,1].map(function(ratio){return Math.round(max*ratio);}):[0]), uniqueTicks=xTicks.filter(function(value,index,list){return index===0||value!==list[index-1];}), areaPolygon=['0% '+((points[0].y/plotHeight)*100).toFixed(2)+'%'].concat(points.map(function(point){return ((point.x/plotWidth)*100).toFixed(2)+'% '+((point.y/plotHeight)*100).toFixed(2)+'%';})).concat(['0% '+((points[points.length-1].y/plotHeight)*100).toFixed(2)+'%']).join(", "), segments=points.slice(1).map(function(point,index){var start=points[index], dx=point.x-start.x, dy=point.y-start.y; return {x:start.x,y:start.y,length:Math.sqrt((dx*dx)+(dy*dy)).toFixed(2),angle:(Math.atan2(dy,dx)*(180/Math.PI)).toFixed(2)};}); return '<div class="card chart-card quantity-line-card"><h3>'+esc(title)+'</h3><div class="quantity-line-wrap"><div class="quantity-line-chart" role="img" aria-label="'+esc(title)+'" style="width:'+chartWidth+'px;height:'+chartHeight+'px"><div class="quantity-line-plot" style="left:'+chartLeft+'px;top:'+chartTop+'px;width:'+plotWidth+'px;height:'+plotHeight+'px">'+uniqueTicks.map(function(value){var x=xFor(value); return '<span class="quantity-line-grid" style="left:'+x.toFixed(2)+'px"></span>';}).join("")+'<div class="quantity-line-area" style="clip-path:polygon('+areaPolygon+')"></div><span class="quantity-line-axis quantity-line-axis-y"></span><span class="quantity-line-axis quantity-line-axis-x"></span>'+segments.map(function(segment){return '<span class="quantity-line-segment" style="left:'+segment.x.toFixed(2)+'px;top:'+segment.y.toFixed(2)+'px;width:'+segment.length+'px;transform:translateY(-50%) rotate('+segment.angle+'deg)"></span>';}).join("")+points.map(function(point){return '<span class="quantity-line-point" style="left:'+point.x.toFixed(2)+'px;top:'+point.y.toFixed(2)+'px"></span>';}).join("")+'</div>'+points.map(function(point){return '<span class="quantity-line-y-label" style="top:'+(chartTop+point.y).toFixed(2)+'px;width:'+(chartLeft-12)+'px">'+esc(point.label)+'</span>';}).join("")+uniqueTicks.map(function(value){return '<span class="quantity-line-x-label" style="left:'+(chartLeft+xFor(value)).toFixed(2)+'px;top:'+(chartTop+plotHeight+10)+'px">'+esc(String(value))+'</span>';}).join("")+'</div></div></div>';}
  function verticalSalesChart(title,data){var rows=(data||[]), max=rows.reduce(function(high,item){return Math.max(high,Number(item&&item.value||0));},0), ticks=[]; if(!rows.length||!max){return '<div class="card"><h3>'+esc(title)+'</h3><p class="muted">No data for this filter yet.</p></div>';} [1,0.75,0.5,0.25,0].forEach(function(ratio){ticks.push({bottom:ratio*100,value:Math.round(max*ratio)});}); return '<div class="card chart-card sales-trend-card"><h3>'+esc(title)+'</h3><div class="sales-trend-layout"><div class="sales-trend-axis">'+ticks.map(function(tick){return '<span class="sales-trend-axis-label" style="bottom:'+tick.bottom+'%">'+esc(money(tick.value))+'</span>';}).join("")+'</div><div class="sales-trend-chart">'+rows.map(function(item){var value=Number(item.value||0), height=value>0?Math.max(6,(value/max)*100):0; return '<div class="sales-trend-bar"><div class="sales-trend-track"><div class="sales-trend-fill" style="height:'+height+'%"></div></div><div class="sales-trend-label">'+esc(item.label)+'</div></div>';}).join("")+'</div></div></div>';}
  function reportView(r){var d=r||{}, filters=state.report.filters||d.filters||{}, employeeOptions=['<option value="">All employees</option>'].concat((d.options&&d.options.employees||[]).map(function(value){return '<option value="'+esc(value)+'"'+(filters.employee===value?' selected':'')+'>'+esc(value)+'</option>';})).join(""), productOptions=['<option value="">All products</option>'].concat((d.options&&d.options.products||[]).map(function(value){return '<option value="'+esc(value)+'"'+(filters.product===value?' selected':'')+'>'+esc(value)+'</option>';})).join(""), mostSold=d.mostSoldItem?'<tr><td>'+esc(d.mostSoldItem.sku||"-")+'</td><td>'+esc(d.mostSoldItem.name||"Unknown Item")+'</td><td>'+esc(String(d.mostSoldItem.qty||0))+'</td></tr>':'<tr><td colspan="3" class="muted">No sales yet this week.</td></tr>'; return shell('<div class="page-header"><div class="page-intro"><h2>Sales Report</h2></div></div><div class="card"><form class="report-filters" id="report-filters"><label>Employee<select name="employee">'+employeeOptions+'</select></label><label>Product<select name="product">'+productOptions+'</select></label><div class="report-filter-actions"><button class="button primary" type="submit">Apply Filters</button><button class="button" type="button" data-report-reset>Reset</button></div></form><p class="muted">Scope: '+esc(d.reportScope||"Sale data for all time")+'</p></div><section class="grid four">'+kpi("Total Sales",money(d.totalSalesValue||0))+kpi("Transactions",String(d.totalTransactions||0))+kpi("Items Sold",String(d.totalItemsSold||0))+kpi("Average Basket",money(d.averageBasket||0))+'</section><section class="grid five report-chart-row"><div class="report-row-card report-span-three">'+verticalSalesChart("Weekly Sales Trend",d.salesTrend||[])+'</div><div class="report-row-card dashboard-span-two">'+donutChart("Payment Mix",d.paymentMix,true,"")+'</div></section><section class="grid two">'+pieChart("Total Sales by Employee",d.salesByEmployee,true)+'<div class="card"><h3>Most Sold Item</h3><div class="table-wrap"><table class="table"><thead><tr><th>Item Code</th><th>Item Description</th><th>Quantity Sold</th></tr></thead><tbody>'+mostSold+'</tbody></table></div></div></section><section class="grid one">'+quantityLineChart("Quantity of Fragrances Sold",d.quantityByProduct||[])+'</section>');}
  function dashboardView(d){var cash=(d.cashierBreakdown||[]).map(function(r){return '<tr><td>'+esc(r.cashier)+'</td><td>'+esc(r.transactions)+'</td><td>'+money(r.sales)+'</td></tr>';}).join(""), payments=(d.paymentBreakdown||[]).map(function(r){return '<tr><td>'+esc(r.method)+'</td><td>'+esc(r.count)+'</td><td>'+money(r.amount)+'</td></tr>';}).join(""), recent=(d.recentTransactions||[]).map(function(r){return '<tr><td>'+esc(r.invoiceNumber)+'</td><td>'+esc(r.customerName)+'</td><td>'+esc(r.cashierName)+'</td><td>'+esc(r.paymentMethod)+'</td><td>'+money(r.total)+'</td></tr>';}).join("")||'<tr><td colspan="5" class="muted">No transactions have been submitted today.</td></tr>', low=(d.lowStock||[]).map(function(r){return '<tr><td>'+esc(r.sku)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.stock)+'</td><td>'+esc(r.reorderLevel)+'</td></tr>';}).join("")||'<tr><td colspan="4" class="muted">No low-stock products right now.</td></tr>', mostSold=d.mostSoldItem?'<tr><td>'+esc(d.mostSoldItem.sku||"-")+'</td><td>'+esc(d.mostSoldItem.name||"Unknown Item")+'</td><td>'+esc(String(d.mostSoldItem.qty||0))+'</td></tr>':'<tr><td colspan="3" class="muted">No sales yet today.</td></tr>', lowStockCount=(d.lowStock||[]).length; return shell('<div class="page-header"><div class="page-intro"><h2>Daily Productivity Dashboard</h2><p class="muted">Report date: '+esc(d.reportDate)+' | Last refresh: '+esc(d.lastRefreshTime)+'</p></div></div><section class="grid five dashboard-kpi-grid">'+kpi("Today\'s Sale",money(d.totalSalesValue),"",salesChangeMeta(d.totalSalesChange))+kpi("Average Basket",money(d.averageBasket))+kpi("Transactions",String(d.totalTransactions))+kpi("Items Sold",String(d.totalItemsSold))+kpi("Low Stock Alerts",String(lowStockCount),lowStockCount>0?"kpi-card-warning":"")+'</section><section class="grid two"><div class="card"><h3>Most Sold Item</h3><div class="table-wrap"><table class="table"><thead><tr><th>Item Code</th><th>Item Description</th><th>Quantity Sold</th></tr></thead><tbody>'+mostSold+'</tbody></table></div></div><div class="card"><h3>Cashier Breakdown</h3><div class="table-wrap"><table class="table"><thead><tr><th>Cashier</th><th>Transactions</th><th>Sales</th></tr></thead><tbody>'+cash+'</tbody></table></div></div></section><section class="grid three dashboard-activity-grid"><div class="card dashboard-span-two"><h3>Recent Transactions</h3><div class="table-wrap"><table class="table"><thead><tr><th>Invoice</th><th>Customer</th><th>Cashier</th><th>Payment</th><th>Total</th></tr></thead><tbody>'+recent+'</tbody></table></div></div><div class="card"><h3>Payment Mix</h3><div class="table-wrap"><table class="table"><thead><tr><th>Method</th><th>Transactions</th><th>Amount</th></tr></thead><tbody>'+payments+'</tbody></table></div></div></section><section class="grid one"><div class="card"><h3>Low Stock</h3><div class="table-wrap"><table class="table"><thead><tr><th>Item Code</th><th>Item Description</th><th>Stock</th><th>Reorder</th></tr></thead><tbody>'+low+'</tbody></table></div></div></section>');}
  function inventoryView(inventory){var rows=inventory.map(function(r){return '<tr><td>'+esc(r.sku)+'</td><td>'+esc(r.name)+'</td><td>'+money(r.price)+'</td><td>'+esc(r.stock)+'</td></tr>';}).join(""); return shell('<div class="page-header"><div><h2>Inventory</h2><p class="muted">Current inventory list and available stock.</p></div></div><div class="card table-wrap"><table class="table"><thead><tr><th>Item Code</th><th>Item Description</th><th>Price</th><th>Stock</th></tr></thead><tbody>'+rows+'</tbody></table></div>');}
  function posView(inventory,d){var options=inventory.map(function(r){return '<option value="'+esc(r.sku)+'">'+esc(r.sku+" - "+r.name+" ("+r.stock+" in stock)")+'</option>';}).join(""); return shell('<div class="page-header"><div class="page-intro"><h2>Transaction Entry Screen</h2></div><div class="pill" id="pos-date-pill">'+posPillText(d)+'</div></div><section class="pos-layout"><div class="card"><div class="summary-line cart-meta-line"><span><strong>Cashier:</strong> '+esc(state.session.fullName)+'</span><span class="cart-customer-line"><strong>Customer:</strong><input id="cart-customer-input" name="customerName" value="Walk-in" aria-label="Customer Name"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>Item Code</th><th>Item Description</th><th>Qty</th><th>Price</th><th>Total</th><th></th></tr></thead><tbody id="cart-body"><tr><td colspan="6" class="muted">No items added yet.</td></tr></tbody></table></div><div class="summary-line"><span>Item Count</span><strong id="cart-items">0</strong></div><div class="summary-line"><span>Invoice Total</span><strong id="cart-subtotal">0</strong></div><div class="payment-options"><p class="payment-label">Payment Method</p><div class="payment-button-group"><button class="button payment-button is-selected" type="button" data-payment-method="Cash" aria-pressed="true">Cash</button><button class="button payment-button is-selected" type="button" data-payment-method="Card" aria-pressed="false">Card</button></div></div><p class="success" id="pos-message" hidden></p></div><div class="card add-item-card"><h3>Add Item</h3><form class="form-grid" id="pos-form"><label>Item<select name="sku" required><option value="">Select an item</option>'+options+'</select></label><label>Quantity<div class="qty-control"><button class="button qty-button" type="button" id="qty-decrease" disabled>-</button><input type="number" name="qty" min="1" value="" required disabled><button class="button qty-button" type="button" id="qty-increase" disabled>+</button></div></label><button class="button" type="submit" id="add-to-cart-button" disabled>Add to Cart</button><p class="warning" id="add-item-message" hidden></p></form></div></section><div class="cash-modal" id="cash-modal" hidden><div class="cash-modal-backdrop" data-cash-close></div><div class="cash-modal-card"><h3>Cash</h3><p class="muted">Enter the amount received from the customer.</p><input id="cash-received-input" type="text" inputmode="numeric" aria-label="Cash amount" autocomplete="off"><div class="cash-summary"><p class="helper cash-summary-row"><span class="cash-summary-label">Invoice Total:</span><strong id="cash-modal-total">0</strong></p><p class="helper cash-summary-row"><span class="cash-summary-label">Cash:</span><strong id="cash-modal-cash">0</strong></p><p class="helper cash-summary-row"><span class="cash-summary-label">Change Due:</span><strong id="cash-modal-change">0</strong></p></div><p class="warning" id="cash-modal-message" hidden></p><div class="inline-actions"><button class="button" type="button" data-cash-close>Cancel</button><button class="button primary" type="button" id="cash-modal-confirm">Confirm</button></div></div></div><div class="cash-modal" id="card-modal" hidden><div class="cash-modal-backdrop" data-card-close></div><div class="cash-modal-card"><h3>Card</h3><p class="muted">Enter the card amount for the transaction.</p><input id="card-received-input" type="text" inputmode="numeric" aria-label="Card amount" autocomplete="off"><div class="cash-summary"><p class="helper cash-summary-row"><span class="cash-summary-label">Invoice Total:</span><strong id="card-modal-total">0</strong></p></div><p class="warning" id="card-modal-message" hidden></p><div class="inline-actions"><button class="button" type="button" data-card-close>Cancel</button><button class="button primary" type="button" id="card-modal-confirm">Confirm</button></div></div></div>');}
  function render(){var app=document.getElementById("app"), p=route().split("/")[0]; if(!app) return; if(state.status==="needs-workbook"||state.status==="error"){stopPosClock(); app.innerHTML=setupView(); bindGlobal(); return;} if(!state.session){stopPosClock(); app.innerHTML=loginView(); bindGlobal(); bindLogin(); return;} if(!state.dataLoaded){stopPosClock(); app.innerHTML=dataUnavailableView(); bindGlobal(); return;} if(p==="dashboard") app.innerHTML=dashboardView(state.dashboard||{}); if(p==="reports") app.innerHTML=reportView(state.report.data||{}); if(p==="inventory") app.innerHTML=inventoryView(state.inventory||[]); if(p==="pos") app.innerHTML=posView(state.inventory||[],state.dashboard||{}); bindGlobal(); if(p==="reports") bindReports(); if(p==="pos"){bindPos(); startPosClock();} else stopPosClock();}
  function bindReports(){var form=document.getElementById("report-filters"), reset=document.querySelector("[data-report-reset]"); if(!form) return; function collectFilters(){return {periodType:"all",date:"",employee:form.employee.value||"",product:form.product.value||""};} function applyFilters(nextFilters){state.report.loading=true; state.message=""; state.report.filters=nextFilters; fetchReport(nextFilters).then(function(r){return hydrateReport(r.data||null,nextFilters);}).then(function(d){state.report.data=d; render();}).catch(function(err){state.message=err.message||"Failed to load report."; render();});} form.addEventListener("submit",function(e){e.preventDefault(); applyFilters(collectFilters());}); if(reset) reset.addEventListener("click",function(){applyFilters({periodType:"all",date:"",employee:"",product:""});});}
  function bindLogin(){var form=document.getElementById("login-form"), msg=document.getElementById("login-message"), userInput=document.querySelector("#login-form input[name='userId']"), submitButton=document.querySelector("#login-form button[type='submit']"); if(!form||!userInput) return; function setLoginLoading(loading){if(!submitButton) return; submitButton.disabled=loading; submitButton.classList.toggle("is-loading",loading); if(userInput) userInput.disabled=loading;} function submitLogin(){var userId=userInput.value.trim(); msg.hidden=true; clearDelayedError(); setLoginLoading(true); loginUser(userId).then(function(r){var nextRoute=defaultRouteForRole(r&&r.data&&r.data.role); saveSession(r.data); state.message=""; go(nextRoute); return refreshData().then(function(){startTimer(); render();}).catch(function(err){state.dataLoaded=false; startTimer(); showDelayedError("Signed in, but could not load the latest dashboard data. "+(err.message||""),function(){});});}).catch(function(err){msg.textContent=err.message||"Failed to sign in."; msg.hidden=false;}).finally(function(){setLoginLoading(false);});} userInput.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault(); submitLogin();}}); form.addEventListener("submit",function(e){e.preventDefault(); submitLogin();});}
  function bindGlobal(){var logout=document.querySelector("[data-action='logout']"), retry=document.querySelector("[data-action='retry-data']"); if(logout) logout.addEventListener("click",function(){clearDelayedError(); clearSession(); render();}); if(retry) retry.addEventListener("click",function(){clearDelayedError(); state.message=state.session?"Reloading database data...":"Retrying backend connection..."; render(); health().then(function(){state.status="ready"; if(state.session) return refreshData(); state.message=""; return null;}).then(function(){render();}).catch(function(err){if(state.session){state.dataLoaded=false; showDelayedError("Could not load backend data. "+(err.message||""),function(){}); return;} state.status="ready"; showDelayedError("Backend is currently unavailable. You can still try to sign in, but data may not load until the connection recovers.",function(){});});});}
  function bindPos(){
    var form=document.getElementById("pos-form"), cart=[], cartBody=document.getElementById("cart-body"), customerInput=document.getElementById("cart-customer-input"), itemsNode=document.getElementById("cart-items"), subtotalNode=document.getElementById("cart-subtotal"), msg=document.getElementById("pos-message"), addItemMsg=document.getElementById("add-item-message"), qtyDown=document.getElementById("qty-decrease"), qtyUp=document.getElementById("qty-increase"), addToCart=document.getElementById("add-to-cart-button"), paymentButtons=Array.prototype.slice.call(document.querySelectorAll("[data-payment-method]")), selectedPaymentMethod="Cash", cashReceived=null, cardReceived=null, cashModal=document.getElementById("cash-modal"), cashInput=document.getElementById("cash-received-input"), cashModalTotal=document.getElementById("cash-modal-total"), cashModalCash=document.getElementById("cash-modal-cash"), cashModalChange=document.getElementById("cash-modal-change"), cashModalMessage=document.getElementById("cash-modal-message"), cashModalConfirm=document.getElementById("cash-modal-confirm"), cashModalClose=Array.prototype.slice.call(document.querySelectorAll("[data-cash-close]")), cardModal=document.getElementById("card-modal"), cardInput=document.getElementById("card-received-input"), cardModalTotal=document.getElementById("card-modal-total"), cardModalMessage=document.getElementById("card-modal-message"), cardModalConfirm=document.getElementById("card-modal-confirm"), cardModalClose=Array.prototype.slice.call(document.querySelectorAll("[data-card-close]"));
    function currentSubtotal(){return Math.round(cart.reduce(function(s,r){return s+r.price*r.qty;},0));}
    function paymentMethod(){return selectedPaymentMethod;}
    function digitsOnly(value){return String(value||"").replace(/\D/g,"");}
    function formatMoneyInput(value){var digits=digitsOnly(value); return digits?Number(digits).toLocaleString(undefined,{maximumFractionDigits:0}):"";}
    function parsedInput(input){var digits=digitsOnly(input.value); return digits?Math.round(Number(digits)):NaN;}
    function updateCashSummary(){var subtotal=currentSubtotal(), parsed=parsedInput(cashInput), cash=Number.isFinite(parsed)?parsed:0, change=Math.max(0,cash-subtotal); cashModalTotal.textContent=money(subtotal); cashModalCash.textContent=money(cash); cashModalChange.textContent=money(change);}
    function updateCardSummary(){cardModalTotal.textContent=money(currentSubtotal());}
    function hideCashModal(){cashModal.hidden=true; cashModalMessage.hidden=true;}
    function hideCardModal(){cardModal.hidden=true; cardModalMessage.hidden=true;}
    function showCashModal(){if(!cart.length){msg.textContent="Add at least one item to the cart before taking payment."; msg.hidden=false; return false;} cashModal.hidden=false; cashInput.value=cashReceived!=null?formatMoneyInput(cashReceived):""; cashModalMessage.hidden=true; updateCashSummary(); window.setTimeout(function(){cashInput.focus(); cashInput.select();},0); return true;}
    function showCardModal(){if(!cart.length){msg.textContent="Add at least one item to the cart before taking payment."; msg.hidden=false; return false;} cardModal.hidden=false; cardInput.value=cardReceived!=null?formatMoneyInput(cardReceived):""; cardModalMessage.hidden=true; updateCardSummary(); window.setTimeout(function(){cardInput.focus(); cardInput.select();},0); return true;}
    function setPaymentMethod(method,skipModal){
      if(method==="Cash"&&!skipModal) return showCashModal();
      if(method==="Card"&&!skipModal) return showCardModal();
      selectedPaymentMethod=method;
      paymentButtons.forEach(function(button){button.setAttribute("aria-pressed",button.getAttribute("data-payment-method")===method?"true":"false");});
      if(method!=="Cash") cashReceived=null;
      if(method!=="Card") cardReceived=null;
      return true;
    }
    function submitTransaction(method,amountReceived,changeDue){
      if(!cart.length){msg.textContent="Add at least one item to the cart before taking payment."; msg.hidden=false; return;}
      msg.hidden=true;
      submitSale({cashierId:state.session.userId,cashierName:state.session.fullName,customerName:customerInput.value.trim()||"Walk-in",customerPhone:"",paymentMethod:method,amountReceived:amountReceived,changeDue:changeDue,items:cart.map(function(r){return{sku:r.sku,itemName:r.name,qty:r.qty,unitPrice:r.price};})}).then(function(result){cart=[]; cashReceived=null; cardReceived=null; customerInput.value="Walk-in"; hideCashModal(); hideCardModal(); setPaymentMethod("Cash",true); form.sku.value=""; form.qty.value=""; addItemMsg.hidden=true; draw(); msg.textContent="Transaction submitted to the database. Invoice: "+result.invoiceNumber; msg.hidden=false; return refreshData().then(render);}).catch(function(err){msg.textContent=err.message||"Failed to save sale."; msg.hidden=false;});
    }
    function confirmCashReceived(){var subtotal=currentSubtotal(); cashReceived=parsedInput(cashInput); if(!Number.isFinite(cashReceived)||cashReceived<subtotal){cashModalMessage.textContent="Cash received cannot be less than the invoice total"; cashModalMessage.hidden=false; return false;} hideCashModal(); return true;}
    function confirmCardReceived(){var subtotal=currentSubtotal(); cardReceived=parsedInput(cardInput); if(!Number.isFinite(cardReceived)||cardReceived<subtotal){cardModalMessage.textContent="Card amount cannot be less than the invoice total"; cardModalMessage.hidden=false; return false;} hideCardModal(); return true;}
    function selectedItem(){return state.inventory.filter(function(r){return r.sku===form.sku.value;})[0];}
    function cartQtyFor(sku){return cart.reduce(function(s,r){return r.sku===sku?s+r.qty:s;},0);}
    function syncQty(){var item=selectedItem(), available=item?Math.max(0,Number(item.stock)-cartQtyFor(item.sku)):0, enabled=!!item&&available>0; form.qty.disabled=!enabled; qtyDown.disabled=!enabled; qtyUp.disabled=!enabled; addToCart.disabled=!enabled; addToCart.classList.toggle("primary",enabled); if(!item){form.qty.min="1"; form.qty.max=""; form.qty.value=""; return;} if(!enabled){form.qty.min="0"; form.qty.max="0"; form.qty.value="0"; return;} form.qty.min="1"; form.qty.max=String(available); if(form.qty.value===""||Number(form.qty.value)<1) form.qty.value="1"; if(Number(form.qty.value)>available) form.qty.value=String(available);}
    function draw(){cartBody.innerHTML=cart.length?cart.map(function(r,i){return '<tr><td>'+esc(r.sku)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.qty)+'</td><td>'+money(r.price)+'</td><td>'+money(r.price*r.qty)+'</td><td><button class="link-button" data-remove-index="'+i+'">Remove</button></td></tr>';}).join(""):'<tr><td colspan="6" class="muted">No items added yet.</td></tr>'; itemsNode.textContent=String(cart.reduce(function(s,r){return s+r.qty;},0)); subtotalNode.textContent=money(currentSubtotal()); Array.prototype.forEach.call(document.querySelectorAll("[data-remove-index]"),function(b){b.addEventListener("click",function(){cart.splice(Number(b.getAttribute("data-remove-index")),1); draw();});}); syncQty();}
    function bindFormattedMoneyInput(input,updateFn,messageNode,closeFn){input.addEventListener("input",function(){var start=input.selectionStart||0, oldLength=input.value.length, formatted=formatMoneyInput(input.value); input.value=formatted; var newLength=formatted.length; var nextPos=Math.max(0,start+(newLength-oldLength)); input.setSelectionRange(nextPos,nextPos); messageNode.hidden=true; updateFn();}); input.addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault(); closeFn();}});}
    customerInput.addEventListener("input",draw);
    paymentButtons.forEach(function(button){button.addEventListener("click",function(){setPaymentMethod(button.getAttribute("data-payment-method"));});});
    cashModalClose.forEach(function(button){button.addEventListener("click",function(){hideCashModal();});});
    cardModalClose.forEach(function(button){button.addEventListener("click",function(){hideCardModal();});});
    cashModalConfirm.addEventListener("click",function(){if(confirmCashReceived()){setPaymentMethod("Cash",true); submitTransaction("Cash",cashReceived,Math.max(0,cashReceived-currentSubtotal()));}});
    cardModalConfirm.addEventListener("click",function(){if(confirmCardReceived()){setPaymentMethod("Card",true); submitTransaction("Card",cardReceived,0);}});
    bindFormattedMoneyInput(cashInput,updateCashSummary,cashModalMessage,hideCashModal);
    bindFormattedMoneyInput(cardInput,updateCardSummary,cardModalMessage,hideCardModal);
    cashInput.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault(); if(confirmCashReceived()){setPaymentMethod("Cash",true); submitTransaction("Cash",cashReceived,Math.max(0,cashReceived-currentSubtotal()));}}});
    cardInput.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault(); if(confirmCardReceived()){setPaymentMethod("Card",true); submitTransaction("Card",cardReceived,0);}}});
    form.sku.addEventListener("change",function(){addItemMsg.hidden=true; syncQty();});
    form.qty.addEventListener("input",function(){var max=Number(form.qty.max||0), value=Number(form.qty.value||0); if(max&&value>max) form.qty.value=String(max); if(value<Number(form.qty.min||1)) form.qty.value=String(form.qty.min||1);});
    qtyDown.addEventListener("click",function(){if(form.qty.disabled)return; var current=Number(form.qty.value||0), min=Number(form.qty.min||1); form.qty.value=String(Math.max(min,current-1));});
    qtyUp.addEventListener("click",function(){if(form.qty.disabled)return; var current=Number(form.qty.value||0), max=Number(form.qty.max||current+1); form.qty.value=String(Math.min(max,current+1));});
    form.addEventListener("submit",function(e){e.preventDefault(); var item=selectedItem(), qty=Number(form.qty.value), currentQty=item?cartQtyFor(item.sku):0; if(!item||qty<1)return; if(currentQty+qty>Number(item.stock)){addItemMsg.textContent="Not enough stock available for "+item.name+"."; addItemMsg.hidden=false; syncQty(); return;} var ex=cart.filter(function(r){return r.sku===item.sku;})[0]; if(ex) ex.qty+=qty; else cart.push({sku:item.sku,name:item.name,price:Number(item.price),qty:qty}); form.qty.value="1"; addItemMsg.hidden=true; msg.hidden=true; draw();});
    draw();
  }
  window.addEventListener("hashchange",function(){render();});
  if(!window.location.hash) window.location.hash=state.session?("#"+defaultRouteForRole(state.session.role)):"#login";
  if(!state.session){state.status="ready"; render();}
  health().then(function(){clearDelayedError(); state.status="ready"; state.message=""; if(state.session) return refreshData(); return null;}).then(function(){render(); if(state.session&&state.status==="ready"){startTimer();}}).catch(function(err){if(state.session){state.status="error"; showDelayedError(err.message||"Could not initialize the app.",function(){state.status="error";}); return;} state.status="ready"; showDelayedError("Backend is currently unavailable. You can still try to sign in, but data may not load until the connection recovers.",function(){state.status="ready";});});
})();
