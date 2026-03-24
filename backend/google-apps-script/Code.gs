function doGet(e) {
  return handleRequest_("GET", e || {});
}

function doPost(e) {
  return handleRequest_("POST", e || {});
}

function handleRequest_(method, e) {
  try {
    var action = method === "GET"
      ? String((e.parameter && e.parameter.action) || "")
      : String((JSON.parse(e.postData.contents || "{}") || {}).action || "");
    var payload = method === "POST"
      ? ((JSON.parse(e.postData.contents || "{}") || {}).payload || {})
      : (e.parameter || {});

    if (!action) {
      return json_({ ok: false, error: "Missing action." });
    }

    if (action === "health") {
      return json_({ ok: true, data: { status: "ok", spreadsheetId: getSpreadsheet_().getId() } });
    }
    if (action === "products") {
      return json_({ ok: true, data: getProducts_() });
    }
    if (action === "dashboard") {
      return json_({ ok: true, data: getDashboard_() });
    }
    if (action === "saleReceipt") {
      return json_({ ok: true, data: getSaleReceipt_(String(payload.saleId || "")) });
    }
    if (action === "sale") {
      return json_(saveSale_(payload));
    }

    return json_({ ok: false, error: "Unsupported action: " + action });
  } catch (error) {
    return json_({ ok: false, error: error.message || String(error) });
  }
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Open this script from a Google Sheet so the backend can use that spreadsheet as the database.");
  }
  return spreadsheet;
}

function initializeDatabase() {
  var spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, "Users", ["userId", "fullName", "email", "password", "role", "activeStatus"], [
    ["U-1001", "Mia Santos", "mia@example.com", "password123", "Cashier", "Y"],
    ["U-1002", "Alex Cruz", "alex@example.com", "password123", "Supervisor", "Y"],
    ["U-1003", "Priya Persaud", "manager@example.com", "password123", "Manager", "Y"]
  ]);
  ensureSheet_(spreadsheet, "Products", ["productId", "sku", "productName", "sellingPrice", "activeStatus"], [
    ["P-1001", "SKU-001", "Notebook A5", 120, "Y"],
    ["P-1002", "SKU-002", "Ballpen Blue", 25, "Y"],
    ["P-1003", "SKU-003", "Printer Paper", 260, "Y"]
  ]);
  ensureSheet_(spreadsheet, "Stock_Balance", ["productId", "sku", "productName", "location", "qtyOnHand", "reservedQty", "availableQty", "reorderLevel", "updatedAt"], [
    ["P-1001", "SKU-001", "Notebook A5", "Main Store", 48, 0, 48, 10, ""],
    ["P-1002", "SKU-002", "Ballpen Blue", "Main Store", 130, 0, 130, 20, ""],
    ["P-1003", "SKU-003", "Printer Paper", "Main Store", 22, 0, 22, 25, ""]
  ]);
  ensureSheet_(spreadsheet, "Settings", ["settingKey", "settingValue", "description"], [
    ["company_name", "Transactional Processing System", ""],
    ["company_address", "Georgetown, Guyana", ""],
    ["company_phone", "+592 000 0000", ""],
    ["inv_counter", "0", ""]
  ]);
  ensureSheet_(spreadsheet, "POS_Sales", ["saleId", "saleDatetime", "businessDate", "cashierId", "cashierName", "customerName", "customerPhone", "location", "notes", "subtotal", "discount", "tax", "total", "paymentMethod", "status", "invoiceNumber"], []);
  ensureSheet_(spreadsheet, "POS_Sale_Items", ["saleItemId", "saleId", "productId", "sku", "productName", "qty", "unitPrice", "lineDiscount", "tax", "lineTotal"], []);
  ensureSheet_(spreadsheet, "Payments", ["paymentId", "saleId", "paidAt", "businessDate", "method", "amount", "reference", "status"], []);
  SpreadsheetApp.flush();
}

function ensureSheet_(spreadsheet, name, headers, rows) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    return;
  }

  var currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  if (headers.join("|") !== currentHeaders.slice(0, headers.length).join("|")) {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
  }
}

function getProducts_() {
  var products = rows_("Products");
  var stockByProduct = indexBy_(rows_("Stock_Balance"), "productId");
  return products
    .filter(function (row) { return String(row.activeStatus || "Y").toUpperCase() !== "N"; })
    .map(function (row) {
      var stock = stockByProduct[row.productId] || {};
      return {
        productId: row.productId,
        sku: row.sku,
        name: row.productName,
        price: number_(row.sellingPrice),
        stock: number_(stock.availableQty)
      };
    });
}

function getDashboard_() {
  var today = dateKey_(new Date());
  var sales = rows_("POS_Sales").filter(function (row) { return String(row.businessDate || "") === today; });
  var saleIds = sales.map(function (row) { return row.saleId; });
  var saleItems = rows_("POS_Sale_Items").filter(function (row) { return saleIds.indexOf(row.saleId) !== -1; });
  var stockRows = rows_("Stock_Balance");
  var cashiers = {};
  var payments = {};

  sales.forEach(function (row) {
    var cashier = row.cashierName || row.cashierId || "Unassigned";
    var method = row.paymentMethod || "Unknown";
    if (!cashiers[cashier]) {
      cashiers[cashier] = { cashier: cashier, transactions: 0, sales: 0 };
    }
    if (!payments[method]) {
      payments[method] = { method: method, count: 0, amount: 0 };
    }
    cashiers[cashier].transactions += 1;
    cashiers[cashier].sales += number_(row.total);
    payments[method].count += 1;
    payments[method].amount += number_(row.total);
  });

  var totalSales = sum_(sales, "total");
  return {
    reportDate: today,
    lastRefreshTime: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss"),
    totalSalesValue: totalSales,
    totalTransactions: sales.length,
    totalItemsSold: sum_(saleItems, "qty"),
    totalReturns: 0,
    totalRefunds: 0,
    refundAmount: 0,
    netSales: totalSales,
    averageBasket: sales.length ? totalSales / sales.length : 0,
    cashierBreakdown: objectValues_(cashiers).length ? objectValues_(cashiers) : [{ cashier: "No sales yet", transactions: 0, sales: 0 }],
    paymentBreakdown: objectValues_(payments).length ? objectValues_(payments) : [{ method: "No payments yet", count: 0, amount: 0 }],
    recentTransactions: sales.slice().reverse().slice(0, 6).map(function (row) {
      return {
        invoiceNumber: row.invoiceNumber,
        saleId: row.saleId,
        customerName: row.customerName || "Walk-in Customer",
        cashierName: row.cashierName || "",
        paymentMethod: row.paymentMethod || "",
        total: number_(row.total),
        saleDatetime: row.saleDatetime || ""
      };
    }),
    lowStock: stockRows.filter(function (row) {
      return number_(row.availableQty) <= number_(row.reorderLevel);
    }).map(function (row) {
      return {
        sku: row.sku,
        name: row.productName,
        stock: number_(row.availableQty),
        reorderLevel: number_(row.reorderLevel)
      };
    })
  };
}

function getSaleReceipt_(saleId) {
  var sale = rows_("POS_Sales").filter(function (row) { return row.saleId === saleId; })[0];
  if (!sale) {
    throw new Error("Sale not found: " + saleId);
  }
  var settings = indexBy_(rows_("Settings"), "settingKey");
  var items = rows_("POS_Sale_Items")
    .filter(function (row) { return row.saleId === saleId; })
    .map(function (row) {
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        qty: number_(row.qty),
        unitPrice: number_(row.unitPrice),
        lineTotal: number_(row.lineTotal)
      };
    });

  return {
    saleId: sale.saleId,
    invoiceNumber: sale.invoiceNumber,
    saleDatetime: sale.saleDatetime,
    cashierName: sale.cashierName,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone || "",
    location: sale.location || "Main Store",
    notes: sale.notes || "",
    paymentMethod: sale.paymentMethod,
    subtotal: number_(sale.subtotal),
    discount: number_(sale.discount),
    tax: number_(sale.tax),
    total: number_(sale.total),
    companyName: settingValue_(settings, "company_name", "Transactional Processing System"),
    companyAddress: settingValue_(settings, "company_address", ""),
    companyPhone: settingValue_(settings, "company_phone", ""),
    items: items
  };
}

function saveSale_(payload) {
  if (!payload || !payload.items || !payload.items.length) {
    throw new Error("Cannot save a sale without items.");
  }

  var spreadsheet = getSpreadsheet_();
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    var settingsSheet = sheet_("Settings");
    var settingsRows = rows_("Settings");
    var settings = indexBy_(settingsRows, "settingKey");
    var stockSheet = sheet_("Stock_Balance");
    var stockRows = rows_("Stock_Balance");
    var stockByProduct = indexBy_(stockRows, "productId");
    var salesSheet = sheet_("POS_Sales");
    var saleItemsSheet = sheet_("POS_Sale_Items");
    var paymentsSheet = sheet_("Payments");
    var subtotal = payload.items.reduce(function (sum, item) {
      return sum + number_(item.qty) * number_(item.unitPrice);
    }, 0);
    var now = new Date();
    var businessDate = dateKey_(now);
    var saleId = nextId_("SALE", salesSheet);
    var saleItemPrefix = "SLI";
    var paymentId = nextId_("PAY", paymentsSheet);
    var invoiceNumber = nextCounter_("inv_counter", "INV", settingsSheet, settingsRows);

    payload.items.forEach(function (item) {
      var stock = stockByProduct[item.productId];
      if (!stock) {
        throw new Error("Stock record not found for " + item.productId);
      }
      if (number_(stock.availableQty) < number_(item.qty)) {
        throw new Error("Not enough stock available for " + item.productName + ".");
      }
    });

    appendRow_("POS_Sales", {
      saleId: saleId,
      saleDatetime: datetime_(now),
      businessDate: businessDate,
      cashierId: payload.cashierId,
      cashierName: payload.cashierName,
      customerName: payload.customerName || "Walk-in Customer",
      customerPhone: payload.customerPhone || "",
      location: payload.location || "Main Store",
      notes: payload.notes || "",
      subtotal: subtotal,
      discount: 0,
      tax: 0,
      total: subtotal,
      paymentMethod: payload.paymentMethod || "Cash",
      status: "COMPLETED",
      invoiceNumber: invoiceNumber
    });

    payload.items.forEach(function (item) {
      appendRow_("POS_Sale_Items", {
        saleItemId: nextId_(saleItemPrefix, saleItemsSheet),
        saleId: saleId,
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        qty: number_(item.qty),
        unitPrice: number_(item.unitPrice),
        lineDiscount: 0,
        tax: 0,
        lineTotal: number_(item.qty) * number_(item.unitPrice)
      });
      decrementStock_(stockSheet, stockRows, item.productId, number_(item.qty));
    });

    appendRow_("Payments", {
      paymentId: paymentId,
      saleId: saleId,
      paidAt: datetime_(now),
      businessDate: businessDate,
      method: payload.paymentMethod || "Cash",
      amount: subtotal,
      reference: "",
      status: "POSTED"
    });

    return {
      ok: true,
      saleId: saleId,
      invoiceNumber: invoiceNumber,
      total: subtotal
    };
  } finally {
    lock.releaseLock();
  }
}

function decrementStock_(sheet, stockRows, productId, qty) {
  var headers = headers_(sheet);
  var rowIndex = -1;
  for (var i = 0; i < stockRows.length; i += 1) {
    if (stockRows[i].productId === productId) {
      rowIndex = i + 2;
      break;
    }
  }
  if (rowIndex === -1) {
    throw new Error("Stock row missing for " + productId);
  }

  var qtyCol = headers.indexOf("qtyOnHand") + 1;
  var availableCol = headers.indexOf("availableQty") + 1;
  var updatedCol = headers.indexOf("updatedAt") + 1;
  var currentQty = number_(sheet.getRange(rowIndex, qtyCol).getValue());
  var currentAvailable = number_(sheet.getRange(rowIndex, availableCol).getValue());
  sheet.getRange(rowIndex, qtyCol).setValue(currentQty - qty);
  sheet.getRange(rowIndex, availableCol).setValue(currentAvailable - qty);
  sheet.getRange(rowIndex, updatedCol).setValue(datetime_(new Date()));
}

function appendRow_(sheetName, objectRow) {
  var sheet = sheet_(sheetName);
  var headers = headers_(sheet);
  var row = headers.map(function (header) {
    return objectRow[header] == null ? "" : objectRow[header];
  });
  sheet.appendRow(row);
}

function nextCounter_(settingKey, prefix, sheet, rows) {
  var headers = headers_(sheet);
  var current = 0;
  var rowIndex = -1;
  rows.forEach(function (row, index) {
    if (row.settingKey === settingKey) {
      current = number_(row.settingValue);
      rowIndex = index + 2;
    }
  });
  current += 1;
  if (rowIndex === -1) {
    sheet.appendRow([settingKey, String(current), ""]);
  } else {
    sheet.getRange(rowIndex, headers.indexOf("settingValue") + 1).setValue(String(current));
  }
  return prefix + "-" + ("0000" + current).slice(-4);
}

function nextId_(prefix, sheet) {
  var next = Math.max(sheet.getLastRow() - 1, 0) + 1;
  return prefix + "-" + ("0000" + next).slice(-4);
}

function sheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error("Missing sheet: " + name + ". Run initializeDatabase() first.");
  }
  return sheet;
}

function rows_(name) {
  var sheet = sheet_(name);
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return [];
  }
  var headers = values[0];
  return values.slice(1).filter(function (row) {
    return row.join("") !== "";
  }).map(function (row) {
    var objectRow = {};
    headers.forEach(function (header, index) {
      objectRow[header] = row[index];
    });
    return objectRow;
  });
}

function headers_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function indexBy_(rows, key) {
  var result = {};
  rows.forEach(function (row) {
    result[row[key]] = row;
  });
  return result;
}

function objectValues_(objectMap) {
  return Object.keys(objectMap).map(function (key) {
    return objectMap[key];
  });
}

function sum_(rows, key) {
  return rows.reduce(function (sum, row) {
    return sum + number_(row[key]);
  }, 0);
}

function number_(value) {
  return Number(value || 0);
}

function settingValue_(settings, key, fallback) {
  return settings[key] ? settings[key].settingValue : fallback;
}

function dateKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function datetime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}
