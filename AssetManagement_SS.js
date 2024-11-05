/**
 * @NApiVersion 2.x
 * @NScriptType ScheduledScript
 */
define(['N/record', 'N/runtime', 'N/log', 'N/search', 'N/email', 'N/task'], function (record, runtime, log, search, email, task) {

    function execute(context) {
        try {
            // Retrieve parameters passed from the User Event script
            var itemReceiptId = runtime.getCurrentScript().getParameter({ name: 'custscript_item_receipt_id' });
            var functionToRun = runtime.getCurrentScript().getParameter({ name: 'custscript_function_to_run' });

            if (!itemReceiptId || !functionToRun) {
                log.error('Missing Parameters', 'Item Receipt ID: ' + itemReceiptId + ' or Function to Run: ' + functionToRun + ' is not provided.');
                return;
            }

            // Load the Item Receipt record once
            var itemReceipt = record.load({
                type: record.Type.ITEM_RECEIPT,
                id: itemReceiptId,
                isDynamic: false
            });

            log.debug('Scheduled Script Started', 'Item Receipt ID: ' + itemReceiptId + ', Function to Run: ' + functionToRun);

            // Call the specified function based on functionToRun parameter
            if (functionToRun === 'handlePurchaseOrder') {
                handlePurchaseOrder(itemReceipt);
            } else if (functionToRun === 'handleTransferOrder') {
                handleTransferOrder(itemReceipt);
            } else if (functionToRun === 'handleLandedCost') {
                handleLandedCost(itemReceipt, itemReceiptId);
            } else {
                log.error('Invalid Function', 'The specified function to run is not recognized: ' + functionToRun);
            }

            ///////////////////////////////////////////////////////
            /// Trigger the FAM Migrate to Precompute SS script ///
            ///////////////////////////////////////////////////////
            try {
                var scriptTask = task.create({
                    taskType: task.TaskType.SCHEDULED_SCRIPT
                });

                scriptTask.scriptId = 'customscript_fam_migratetoprecompute_ss';
                scriptTask.deploymentId = 'customdeploy_fam_migratetoprecompute_ss';

                var taskId = scriptTask.submit();
                log.debug('Scheduled Script Task Submitted', 'Task ID: ' + taskId);
            } catch (e) {
                log.error('Error scheduling script', e.message);
            }

        } catch (error) {
            log.error('Scheduled Script Error', error);
        }
    }

    function handleLandedCost(itemReceipt, itemReceiptId) {
        log.debug('Handling Landed Cost', 'Item Receipt ID: ' + itemReceipt);

        // Initialize total variables
        var totalOfItems = 0;
        var totalLandedCost = 0;

        // Get the exchange rate for later
        var exchangeRate = getExchangeRate(itemReceipt.getValue({ fieldId: 'subsidiary' }), itemReceipt);

        // Get the line count
        var itemCount = itemReceipt.getLineCount({ sublistId: 'item' });

        // Calculate total landed cost
        var landedCostFields = [
            'landedcostamount6',
            'landedcostamount7',
            'landedcostamount8',
            'landedcostamount9',
            'landedcostamount10'
        ];

        landedCostFields.forEach(function (fieldId) {
            totalLandedCost += parseFloat(itemReceipt.getValue({ fieldId: fieldId })) || 0;
        });

        totalLandedCost = totalLandedCost * exchangeRate

        log.debug('Initial Values', {
            itemReceiptId: itemReceiptId,
            exchangeRate: exchangeRate,
            totalLandedCost: totalLandedCost
        });

        // Calculate total value of each line item
        for (var i = 0; i < itemCount; i++) {
            var quantity = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
            var rate = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
            log.debug('Item Calculation', {
                line: i,
                quantity: quantity,
                rate: rate,
                exchangeRate: exchangeRate
            });
            var amount = (quantity * rate) * exchangeRate;
            log.debug('Item Calculation', {
                line: i,
                quantity: quantity,
                rate: rate,
                amount: amount,
                exchangeRate: exchangeRate
            });
            totalOfItems += amount;
        }

        // Distribute landed cost to each item proportionately
        for (var i = 0; i < itemCount; i++) {
            var quantity = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
            var rate = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });

            var amount = (quantity * rate) * exchangeRate;
            var proportion = amount / totalOfItems;
            var individualItemsLandedPortion = proportion * totalLandedCost;
            var newAmount = (amount + individualItemsLandedPortion);
            var serialNumbers = [];

            log.debug('Distributing Landed Cost', {
                line: i,
                amount: amount,
                proportion: proportion,
                individualItemsLandedPortion: individualItemsLandedPortion,
                newAmount: newAmount
            });

            // Handle inventory detail for each line item
            var inventoryDetailSubrecord = itemReceipt.getSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail',
                line: i
            });

            if (inventoryDetailSubrecord) {
                var inventoryAssignmentCount = inventoryDetailSubrecord.getLineCount({ sublistId: 'inventoryassignment' });

                for (var j = 0; j < inventoryAssignmentCount; j++) {
                    var serialNumber = inventoryDetailSubrecord.getSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'receiptinventorynumber',
                        line: j
                    });
                    serialNumbers.push(serialNumber);
                }
            }

            if (serialNumbers.length > 0) {
                var filters = [
                    ['custrecord_grandparent_transaction', 'is', itemReceiptId]
                ];

                var serialNumberFilters = serialNumbers.map(function (serialNumber) {
                    return ['custrecord_assetserialno', 'is', serialNumber];
                });

                // Add 'OR' condition between serial number filters
                if (serialNumberFilters.length > 1) {
                    var combinedFilters = [];
                    serialNumberFilters.forEach(function (filter, index) {
                        combinedFilters.push(filter);
                        if (index < serialNumberFilters.length - 1) {
                            combinedFilters.push('OR');
                        }
                    });
                    filters.push('AND', combinedFilters);
                } else {
                    filters.push('AND', serialNumberFilters);
                }

                var assetSearch = search.create({
                    type: 'customrecord_ncfar_asset',
                    filters: filters,
                    columns: [
                        'internalid',
                        'custrecord_ncfar_quantity',
                        'custrecord_assetcost',
                        'custrecord_assetcurrentcost',
                        'custrecord_assetbookvalue'
                    ]
                });

                var assetResults = assetSearch.run().getRange({ start: 0, end: 1000 });

                assetResults.forEach(function (result) {
                    var assetId = result.getValue({ name: 'internalid' });
                    var assetQuantity = parseFloat(result.getValue({ name: 'custrecord_ncfar_quantity' })) || 0;
                    var newCost = assetQuantity * (newAmount / quantity);

                    var assetRecord = record.load({
                        type: 'customrecord_ncfar_asset',
                        id: assetId,
                        isDynamic: true
                    });

                    log.debug('Updating Asset Record', {
                        assetId: assetId,
                        assetQuantity: assetQuantity,
                        newAmount: newAmount,
                        quantity: quantity,
                        newCost: newCost
                    });

                    assetRecord.setValue({ fieldId: 'custrecord_assetcost', value: newCost });
                    assetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: newCost });
                    assetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: newCost });
                    assetRecord.save();
                });
            }
        }
        log.debug('Handling Landed Cost', 'Completed');
    }

    function handlePurchaseOrder(itemReceipt) {
        log.debug('Purchase Order', 'Handle Purchase Order Function');
        // Handle the creation of new asset records
        var itemCount = itemReceipt.getLineCount({ sublistId: 'item' });
        var exchangeRate = getExchangeRate(itemReceipt.getValue({ fieldId: 'subsidiary' }), itemReceipt);
        var location = itemReceipt.getValue({ fieldId: 'location' });
        var subsidiary = itemReceipt.getValue({ fieldId: 'subsidiary' });
        var currencyMapping = {
            '1': '1', // UK - GBP
            '7': '6', // Sierra Leone - Sierra Leonean Leones
            '8': '7', // Liberia - Liberian Dollars
            '9': '8', // Nigeria - Nira
            '21': '8', // Test NG - Nira
            '14': '9' // DRC - Congolese Francs
        };
        var assetMapping = {
            //1941 MOPO50 Batteries Type: MOPO50 Batteries	
            '1241': { type: '103', method: '3', residual: 0.0, lifetime: 48 },
            // 1944	MOPO50 Charging Units  Type: MOPO50 Charging Units
            '1244': { type: '104', method: '3', residual: 0.0, lifetime: 60 },
            // 1981 System Control Unit  Type: MOPO50 System Control Unit
            '1271': { type: '106', method: '3', residual: 0.0, lifetime: 60 },
            // 1953 Solar PV, Electrical & Structural Assets  Type: Solar PV, Electrical & Structural Assets	
            '1253': { type: '105', method: '3', residual: 0.0, lifetime: 60 },
            // 1959 MOPOMAX Batteries  Type: MOPOMAX Batteries	
            '1259': { type: '109', method: '3', residual: 0.0, lifetime: 48 },
            // 1962 MOPOMAX Charge Units  Type: MOPOMAX Charge Units
            '1262': { type: '110', method: '3', residual: 0.0, lifetime: 60 },
            // 1987 MOPOMAX System Control Unit  Type: MOPOMAX System Control Unit
            '1277': { type: '114', method: '3', residual: 0.0, lifetime: 60 },
            // 1990 LFP/Storage Batteries  Type: LFP/Storage Batteries
            '1280': { type: '113', method: '3', residual: 0.0, lifetime: 60 },
            // 1804 Computer Equipment  Type: Computer equipment
            '273': { type: '102', method: '3', residual: 0.0, lifetime: 36 },
            // 1965 Electric Vehicles  Type: Electric Vehicles
            '1265': { type: '111', method: '3', residual: 0.0, lifetime: 36 },
            // Generator Replacement
            '1268': { type: '112', method: '3', residual: 0.0, lifetime: 36 }
        };

        for (var i = 0; i < itemCount; i++) {
            var item = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });
            log.debug('Item', item);

            var displayName = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'displayname',
                line: i
            });

            // Check if the item has inventory detail subrecord (indicating it's an inventory item)
            var inventoryDetailSubrecord = itemReceipt.getSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail',
                line: i
            });

            if (!inventoryDetailSubrecord) {
                log.debug('Skipping non-inventory item:', item);
                continue;
            }

            var assetAccount = search.lookupFields({
                type: search.Type.ITEM,
                id: item,
                columns: ['assetaccount']
            }).assetaccount[0].value;

            var receivedCost = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'rate',
                line: i
            });

            if (assetMapping[assetAccount]) {
                var inventoryDetailSubrecord = itemReceipt.getSublistSubrecord({
                    sublistId: 'item',
                    fieldId: 'inventorydetail',
                    line: i
                });

                var inventoryAssignmentCount = inventoryDetailSubrecord ? inventoryDetailSubrecord.getLineCount({ sublistId: 'inventoryassignment' }) : 0;

                for (var j = 0; j < inventoryAssignmentCount; j++) {
                    createAssetRecord(itemReceipt, i, j, assetMapping[assetAccount], inventoryDetailSubrecord, exchangeRate, receivedCost, displayName, location, subsidiary, item, currencyMapping);
                }
            }
        }
    }

    function createAssetRecord(itemReceipt, line, inventoryLine, mapping, inventoryDetailSubrecord, exchangeRate, receivedCost, displayName, location, subsidiary, item, currencyMapping) {
        var assetRecord = record.create({
            type: 'customrecord_ncfar_asset',
            isDynamic: true
        });

        var serialNumber = inventoryDetailSubrecord.getSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'receiptinventorynumber',
            line: inventoryLine
        });
        var itemDetailQty = inventoryDetailSubrecord.getSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'quantity',
            line: inventoryLine
        });
        var assetValue = (receivedCost * itemDetailQty) * exchangeRate;
        var today = new Date();

        // Populate the asset record fields based on the mapping and item receipt data
        assetRecord.setValue({ fieldId: 'custrecord_assettype', value: mapping.type });
        assetRecord.setValue({ fieldId: 'custrecord_assetaccmethod', value: mapping.method });
        assetRecord.setValue({ fieldId: 'custrecord_assetresidualvalue', value: mapping.residual });
        assetRecord.setValue({ fieldId: 'custrecord_assetlifetime', value: mapping.lifetime });
        assetRecord.setValue({ fieldId: 'altname', value: displayName });
        assetRecord.setValue({ fieldId: 'custrecord_assetdescr', value: "This asset was automatically generated by Sam’s Asset Creation Script" });
        assetRecord.setValue({ fieldId: 'custrecord_assetserialno', value: serialNumber });
        assetRecord.setValue({ fieldId: 'custrecord_assetsubsidiary', value: subsidiary });
        assetRecord.setValue({ fieldId: 'custrecord_assetlocation', value: location });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrn', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_grandparent_transaction', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrnline', value: line });
        assetRecord.setValue({ fieldId: 'custrecord_asset_item', value: item });
        assetRecord.setValue({ fieldId: 'custrecord_assetpurchasedate', value: today });
        assetRecord.setValue({ fieldId: 'custrecord_assetdeprrules', value: 1 });
        assetRecord.setValue({ fieldId: 'custrecord_assetrevisionrules', value: 1 });
        assetRecord.setValue({ fieldId: 'custrecord_assetcost', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: itemDetailQty });
        assetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: itemDetailQty });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrency', value: currencyMapping[subsidiary] });

        var assetRecordId = assetRecord.save();
        log.debug('Asset record created', 'Asset record ID: ' + assetRecordId);
    }

    function getExchangeRate(subsidiaryId, itemReceipt) {
        var fromCurrencyId = getCurrencyIdBySubsidiary(subsidiaryId);
        var toCurrencyId = '1'; // Internal ID of the source currency

        // Default to today's date
        var dateToUse = new Date();

        // Get the created from record (Purchase Order or Transfer Order)
        var createdFrom = itemReceipt.getValue({ fieldId: 'createdfrom' });

        if (createdFrom) {
            var sourceType = search.lookupFields({
                type: search.Type.TRANSACTION,
                id: createdFrom,
                columns: ['type']
            }).type[0].value;

            if (sourceType === 'PurchOrd') {
                // Load the Purchase Order
                var purchaseOrder = record.load({
                    type: record.Type.PURCHASE_ORDER,
                    id: createdFrom,
                    isDynamic: false
                });

                // Search for the related Vendor Bill using Purchase Order ID
                var billSearch = search.create({
                    type: search.Type.VENDOR_BILL,
                    filters: [
                        ['createdfrom', 'anyof', purchaseOrder.id]
                    ],
                    columns: [
                        search.createColumn({ name: 'trandate', sort: search.Sort.DESC })
                    ]
                });

                var billDate;
                billSearch.run().each(function (result) {
                    billDate = result.getValue('trandate');
                    return false; // Only use the first result
                });
            }
        }

        function formatDate(date) {
            var dd = date.getDate();
            var mm = date.getMonth() + 1; // January is 0!
            var yy = String(date.getFullYear()).slice(-2); // Get last two digits of the year
            // Manual padding
            dd = dd < 10 ? '0' + dd : dd;
            mm = mm < 10 ? '0' + mm : mm;

            return (!billDate ? dd + '/' + mm + '/' + yy : mm + '/' + dd + '/' + yy);
        }

        function getExchangeRateForDate(formattedDate) {
            // Search for the exchange rate
            var exchangeRateSearch = search.create({
                type: 'currencyrate',
                filters: [
                    ['basecurrency', 'is', fromCurrencyId],
                    'AND',
                    ['transactioncurrency', 'is', toCurrencyId],
                    'AND',
                    ['effectivedate', 'on', formattedDate]
                ],
                columns: [
                    search.createColumn({ name: 'exchangerate' })
                ]
            });

            var exchangeRate;
            exchangeRateSearch.run().each(function (result) {
                exchangeRate = result.getValue('exchangerate');
                return false; // Only expect one result
            });

            return exchangeRate;
        }
        if (!billDate) {
            var formattedDate = formatDate(dateToUse);
        } else { formattedDate = billDate }
        var exchangeRate = getExchangeRateForDate(formattedDate);

        if (!exchangeRate) {
            dateToUse.setDate(dateToUse.getDate() - 1);
            formattedDate = formatDate(dateToUse);
            exchangeRate = getExchangeRateForDate(formattedDate);
            log.debug('No exchange rate found for initial date.', 'Trying previous day: ' + formattedDate);
        }

        if (!exchangeRate) {
            throw new Error('Exchange rate not found for the given date or the previous day. From currency ' + fromCurrencyId + ' to currency ' + toCurrencyId + ' on ' + formattedDate);
        }

        log.debug('Exchange Rate Retrieval', {
            formattedDate: formattedDate,
            exchangeRate: exchangeRate
        });
        return exchangeRate;
    }

    function getCurrencyIdBySubsidiary(subsidiaryId) {
        var currencyMapping = {
            '1': '1', // UK - GBP
            '7': '6', // Sierra Leonean Leones 
            '8': '7', // Liberian Dollars 
            '9': '8', // Nigerian Nira 
            '21': '8', // Test NG - Nira
            '14': '9' // Congolese Francs 
        };

        return currencyMapping[subsidiaryId];
    }

    function handleTransferOrder(itemReceipt) {
        log.debug('Transfer Order', 'Handle Transfer Order Function');
        var itemCount = itemReceipt.getLineCount({ sublistId: 'item' });
        // Get or create Monthly Changes Parent record for current month
        var changesRecordId = findOrCreateMonthlyChangesRecord(new Date());
        var unmatchedSerialNumbers = [];
        var insufficientQuantityItems = [];

        // Define the asset mapping
        var assetMapping = {
            '1241': { type: '103', method: '3', residual: 0.0, lifetime: 48 },
            '1244': { type: '104', method: '3', residual: 0.0, lifetime: 60 },
            '1271': { type: '106', method: '3', residual: 0.0, lifetime: 60 },
            '1253': { type: '105', method: '3', residual: 0.0, lifetime: 60 },
            '1259': { type: '109', method: '3', residual: 0.0, lifetime: 48 },
            '1262': { type: '110', method: '3', residual: 0.0, lifetime: 60 },
            '1277': { type: '114', method: '3', residual: 0.0, lifetime: 60 },
            '1280': { type: '113', method: '3', residual: 0.0, lifetime: 60 },
            '273': { type: '102', method: '3', residual: 0.0, lifetime: 36 },
            '1265': { type: '111', method: '3', residual: 0.0, lifetime: 36 },
            '1268': { type: '112', method: '3', residual: 0.0, lifetime: 36 }
        };

        for (var i = 0; i < itemCount; i++) {
            var item = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            var inventoryDetailSubrecord = itemReceipt.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: i });
            var inventoryAssignmentCount = inventoryDetailSubrecord ? inventoryDetailSubrecord.getLineCount({ sublistId: 'inventoryassignment' }) : 0;

            var displayName = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'displayname',
                line: i
            });

            // Lookup asset account for the item
            var assetAccount = search.lookupFields({ type: search.Type.ITEM, id: item, columns: ['assetaccount'] }).assetaccount[0].value;
            if (!assetMapping[assetAccount]) continue; // Skip processing this item if not in asset mapping

            for (var j = 0; j < inventoryAssignmentCount; j++) {
                var serialNumber = inventoryDetailSubrecord.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: j });
                if (!serialNumber) {
                    log.debug('Error', 'No serial/lot number for ' + item);
                    continue;
                }

                var transferQuantity = inventoryDetailSubrecord.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j });
                var location = itemReceipt.getValue({ fieldId: 'location' }); // Destination
                var transferLocation = itemReceipt.getValue({ fieldId: 'transferlocation' }); // Source

                var existingAssetSearch = search.create({
                    type: 'customrecord_ncfar_asset',
                    filters: [
                        ['custrecord_assetserialno', 'is', serialNumber],
                        'AND',
                        ['custrecord_assetlocation', 'anyof', [location, transferLocation]],
                        'AND',
                        ['custrecord_ncfar_quantity', 'greaterthan', 0], // Filter for quantity greater than 0
                        'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        'internalid', 'custrecord_ncfar_quantity', 'custrecord_assetcost',
                        'custrecord_assetcurrentcost', 'custrecord_assetbookvalue',
                        'custrecord_assetlocation', 'custrecord_assetserialno',
                        'custrecord_asset_item', 'custrecord_grandparent_transaction',
                        'custrecord_assetdeprstartdate' // Include depreciation start date
                    ]
                });

                var matchingAssets = [];
                existingAssetSearch.run().each(function (result) {
                    var quantity = parseInt(result.getValue('custrecord_ncfar_quantity'), 10);
                    if (isNaN(quantity)) {
                        log.error('Invalid Quantity', 'Asset ID: ' + result.getValue('internalid') + ', Quantity: ' + result.getValue('custrecord_ncfar_quantity'));
                        return true;
                    }

                    matchingAssets.push({
                        id: result.getValue('internalid'),
                        serialNumber: result.getValue('custrecord_assetserialno'),
                        item: result.getValue('custrecord_asset_item'),
                        quantity: quantity,
                        cost: parseFloat(result.getValue('custrecord_assetcost')),
                        currentCost: parseFloat(result.getValue('custrecord_assetcurrentcost')),
                        bookValue: parseFloat(result.getValue('custrecord_assetbookvalue')),
                        location: result.getValue('custrecord_assetlocation'),
                        grandparent: result.getValue('custrecord_grandparent_transaction'),
                        deprStartDate: result.getValue('custrecord_assetdeprstartdate'), // Capture depreciation start date
                        deprToDate: result.getValue('custrecord_assetdeprtodate')
                    });

                    return true;
                });

                if (matchingAssets.length === 0) {
                    unmatchedSerialNumbers.push({
                        itemName: displayName,
                        serialNumber: serialNumber
                    });
                    continue;
                }

                var totalAvailableQuantity = 0;
                var locationAssets = [];
                var transferLocationAssets = [];

                // Separate transferLocation and location assets and calculate total available quantity
                matchingAssets.forEach(function (asset) {
                    if (asset.location === transferLocation) { // Source location
                        transferLocationAssets.push(asset);
                        totalAvailableQuantity += asset.quantity;
                    } else if (asset.location === location) { // Destination location
                        locationAssets.push(asset);
                    }
                });

                // Log total quantities available and to be transferred
                log.debug('Total Available Quantity in Transfer Location', totalAvailableQuantity);
                log.debug('Quantity to Transfer', transferQuantity);

                // Ensure total quantity available can fulfill transfer
                if (totalAvailableQuantity < transferQuantity) {
                    insufficientQuantityItems.push({
                        itemName: displayName,
                        serialNumber: serialNumber
                    });
                    log.error('Insufficient Quantity', 'Not enough assets to fulfill the transfer quantity for serial number: ' + serialNumber);
                    continue;
                }

                // Process transfer by looping through transferLocation assets (source)
                transferLocationAssets.forEach(function (transferLocationAsset) {
                    if (transferQuantity <= 0) return; // Stop when transfer is fulfilled

                    // Loop through all location assets to find matching depreciation dates
                    var matchingLocationAsset = null;
                    locationAssets.forEach(function (locationAsset) {
                        // Set transferLocationAssetDeprStartDate to today's date if it's missing
                        var today = new Date();

                        var dd = today.getDate();
                        var mm = today.getMonth() + 1;
                        var yyyy = today.getFullYear();
                        if (dd < 10) {
                            dd = '0' + dd;
                        }
                        if (mm < 10) {
                            mm = '0' + mm;
                        }
                        today = dd + '/' + mm + '/' + yyyy;

                        var transferLocationAssetDeprStartDate = transferLocationAsset.deprStartDate || today;
                        var locationAssetDeprStartDate = locationAsset.deprStartDate;
                        var locationAssetDeprToDate = locationAsset.deprToDate; // Assuming deprToDate is retrieved as part of the asset record

                        // Ensure 'custrecord_assetdeprtodate' is not greater than 0 before merging
                        if (
                            transferLocationAssetDeprStartDate &&
                            locationAssetDeprStartDate &&
                            isSameMonthAndYear(new Date(transferLocationAssetDeprStartDate), new Date(locationAssetDeprStartDate)) &&
                            (!locationAssetDeprToDate || parseFloat(locationAssetDeprToDate) <= 0) // Check deprToDate condition
                        ) {
                            matchingLocationAsset = locationAsset;
                            log.debug('Found matching location asset', {
                                locationAssetId: locationAsset.id,
                                transferLocationAssetId: transferLocationAsset.id
                            });
                            return; // Exit loop once a matching asset is found
                        }
                    });

                    if (matchingLocationAsset) {
                        // If matching assets are found to be merged.
                        log.debug('Merging assets with matching dates.');
                        if (transferLocationAsset.quantity <= transferQuantity) {
                            // Transfer the total quantity
                            log.debug('Merged full asset quantity', {
                                transferredQuantity: transferQuantity,
                                matchingLocationAssetquantity: matchingLocationAsset.quantity,
                                remainingSourceQuantity: transferLocationAsset.quantity
                            });
                            updateAssetValues(changesRecordId, itemReceipt, matchingLocationAsset, transferLocationAsset, transferLocationAsset.quantity, transferLocationAsset.quantity - transferQuantity, matchingLocationAsset.quantity + transferLocationAsset.quantity);

                            // Update the in-memory quantity of matchingLocationAsset
                            matchingLocationAsset.quantity += transferLocationAsset.quantity;

                            transferQuantity -= transferLocationAsset.quantity; // Reduce remaining quantity to transfer
                        } else {
                            // Split the asset for partial transfer
                            log.debug('Split asset for partial transfer', {
                                transferredQuantity: transferQuantity,
                                matchingLocationAssetquantity: matchingLocationAsset.quantity,
                                remainingSourceQuantity: transferLocationAsset.quantity
                            });
                            updateAssetValues(changesRecordId, itemReceipt, matchingLocationAsset, transferLocationAsset, transferQuantity, transferLocationAsset.quantity - transferQuantity, matchingLocationAsset.quantity + transferQuantity);
                            transferQuantity = 0; // Transfer fulfilled

                            // Update the in-memory quantity of matchingLocationAsset
                            matchingLocationAsset.quantity += transferQuantity;
                        }
                    } else {
                        log.debug('No matching location asset, handling separately.');
                        // Different month/year or no match: handle separately
                        if (transferLocationAsset.quantity <= transferQuantity) {
                            updateAssetLocation(changesRecordId, transferLocationAsset, location, itemReceipt);
                            log.debug('Moved full asset to new location', {
                                transferredQuantity: transferLocationAsset.quantity,
                                remainingTransferQuantity: transferQuantity - transferLocationAsset.quantity
                            });
                            transferQuantity -= transferLocationAsset.quantity; // Reduce remaining quantity to transfer
                        } else {
                            log.debug('Created new asset for partial transfer', {
                                transferredQuantity: transferQuantity,
                                remainingSourceQuantity: transferLocationAsset.quantity
                            });
                            createNewAsset(changesRecordId, itemReceipt, i, j, assetMapping[assetAccount], inventoryDetailSubrecord, transferQuantity, location, transferLocationAsset, displayName); // Create new asset at destination
                            updateAssetValue(changesRecordId, itemReceipt, transferLocationAsset, transferQuantity, transferLocationAsset.quantity - transferQuantity);
                            transferQuantity = 0; // Transfer fulfilled
                        }
                    }
                });
            }

            if (unmatchedSerialNumbers.length > 0 || insufficientQuantityItems.length > 0) {
                sendEmail(unmatchedSerialNumbers, insufficientQuantityItems, itemReceipt);
            }
        }
    }

    function isSameMonthAndYear(date1, date2) {
        var month1 = date1.getMonth(); // 0-based index
        var year1 = date1.getFullYear();

        var month2 = date2.getMonth();
        var year2 = date2.getFullYear();

        return (month1 === month2 && year1 === year2);
    }

    function updateAssetLocation(changesRecordId, asset, newLocation, itemReceipt) {
        var assetDetails = {};
        var assetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: asset.id,
            isDynamic: true
        });
        assetDetails.oldLocation = assetRecord.getValue({ fieldId: 'custrecord_assetlocation' })
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrn', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_assetlocation', value: newLocation });
        assetRecord.setValue({ fieldId: 'custrecord_assetdepractive', value: 1 });

        var deprStartDate = assetRecord.getValue({ fieldId: 'custrecord_assetdeprstartdate' });
        if (!deprStartDate) {
            var today = new Date();
            assetRecord.setValue({ fieldId: 'custrecord_assetdeprstartdate', value: today });
        }
        // 2 = Depreciating
        assetRecord.setValue({ fieldId: 'custrecord_assetstatus', value: 2 });
        assetRecord.save();

        assetDetails.itemReceiptId = itemReceipt.id;
        assetDetails.newLocation = newLocation;
        assetDetails.assetId = assetRecord.id
        createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, 'Updated');
    }

    function updateAssetValue(changesRecordId, itemReceipt, transferLocationAsset, quantity, transferLocationQuantity) {
        var assetDetails = {};
        var updatedCost = (transferLocationAsset.cost / transferLocationAsset.quantity) * quantity;
        var updatedCurrentCost = (transferLocationAsset.currentCost / transferLocationAsset.quantity) * quantity;
        var updatedBookValue = (transferLocationAsset.bookValue / transferLocationAsset.quantity) * quantity;

        // Load the transfer location asset record
        var transferLocationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: transferLocationAsset.id,
            isDynamic: true
        });

        assetDetails.oldQuantity = transferLocationAsset.quantity;
        assetDetails.oldValue = transferLocationAsset.cost;
        assetDetails.itemReceiptId = itemReceipt.id;
        assetDetails.newQuantity = transferLocationQuantity;
        assetDetails.newValue = transferLocationAsset.cost - updatedCost;
        assetDetails.assetId = transferLocationAssetRecord.id
        createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, 'Updated');

        // Update transfer location asset record values
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: transferLocationAsset.cost - updatedCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: transferLocationAsset.currentCost - updatedCurrentCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: transferLocationAsset.bookValue - updatedBookValue });
        if (transferLocationQuantity <= 0) {
            transferLocationAssetRecord.setValue({ fieldId: 'isinactive', value: true });
            transferLocationQuantity = 0
        }
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: transferLocationQuantity });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: transferLocationQuantity });
        transferLocationAssetRecord.save();
    }

    function updateAssetValues(changesRecordId, itemReceipt, locationAsset, transferLocationAsset, quantity, transferLocationQuantity, locationQuantity) {
        var assetDetails = {};

        var updatedCost = (transferLocationAsset.cost / transferLocationAsset.quantity) * quantity;
        var updatedCurrentCost = (transferLocationAsset.currentCost / transferLocationAsset.quantity) * quantity;
        var updatedBookValue = (transferLocationAsset.bookValue / transferLocationAsset.quantity) * quantity;

        // Load the location asset record
        var locationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: locationAsset.id,
            isDynamic: true
        });

        assetDetails.oldQuantity = locationAsset.quantity;
        assetDetails.oldValue = locationAsset.cost;

        // Update location asset record values
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: locationAsset.cost + updatedCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: locationAsset.currentCost + updatedCurrentCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: locationAsset.bookValue + updatedBookValue });
        locationAssetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: locationQuantity });
        locationAssetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: locationQuantity });
        locationAssetRecord.save();

        assetDetails.itemReceiptId = itemReceipt.id;
        assetDetails.newQuantity = locationQuantity;
        assetDetails.newValue = locationAsset.cost + updatedCost;
        assetDetails.assetId = locationAssetRecord.id
        createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, 'Updated');
        var assetDetails = {};

        // Load the transfer location asset record
        var transferLocationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: transferLocationAsset.id,
            isDynamic: true
        });

        assetDetails.oldQuantity = transferLocationAsset.quantity;
        assetDetails.oldValue = transferLocationAsset.cost;
        assetDetails.itemReceiptId = itemReceipt.id;
        assetDetails.newQuantity = transferLocationQuantity;
        assetDetails.newValue = transferLocationAsset.cost - updatedCost;
        assetDetails.assetId = transferLocationAssetRecord.id
        createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, 'Updated');

        // Update transfer location asset record values
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: transferLocationAsset.cost - updatedCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: transferLocationAsset.currentCost - updatedCurrentCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: transferLocationAsset.bookValue - updatedBookValue });
        if (transferLocationQuantity <= 0) {
            transferLocationAssetRecord.setValue({ fieldId: 'isinactive', value: true });
            transferLocationQuantity = 0
        }
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: transferLocationQuantity });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: transferLocationQuantity });
        transferLocationAssetRecord.save();
    }

    function createNewAsset(changesRecordId, itemReceipt, line, inventoryLine, mapping, inventoryDetailSubrecord, quantity, location, transferLocationAsset, displayName) {
        // Similar to createAssetRecord function but with specified location and quantity
        var assetRecord = record.create({
            type: 'customrecord_ncfar_asset',
            isDynamic: true
        });

        // Use existing values from previous asset to determine cost and value of new asset.
        var updatedCost = (transferLocationAsset.cost / transferLocationAsset.quantity) * quantity;
        var updatedCurrentCost = (transferLocationAsset.currentCost / transferLocationAsset.quantity) * quantity;
        var updatedBookValue = (transferLocationAsset.bookValue / transferLocationAsset.quantity) * quantity;

        assetRecord.setValue({ fieldId: 'custrecord_assetcost', value: updatedCost });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: updatedCurrentCost });
        assetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: updatedBookValue });

        // Populate the asset record fields based on the mapping and item receipt data
        assetRecord.setValue({ fieldId: 'custrecord_assettype', value: mapping.type });
        assetRecord.setValue({ fieldId: 'custrecord_assetaccmethod', value: mapping.method });
        assetRecord.setValue({ fieldId: 'custrecord_assetresidualvalue', value: mapping.residual });
        assetRecord.setValue({ fieldId: 'custrecord_assetlifetime', value: mapping.lifetime });

        // Set other fields
        var item = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: line });
        var serialNumber = inventoryDetailSubrecord.getSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'receiptinventorynumber',
            line: inventoryLine
        });

        assetRecord.setValue({ fieldId: 'custrecord_assetparent', value: transferLocationAsset.name });
        assetRecord.setValue({ fieldId: 'altname', value: displayName });
        assetRecord.setValue({ fieldId: 'custrecord_assetdescr', value: "This asset was automatically generated by Sam’s Asset Creation Script" });
        assetRecord.setValue({ fieldId: 'custrecord_assetserialno', value: serialNumber });
        assetRecord.setValue({ fieldId: 'custrecord_assetsubsidiary', value: itemReceipt.getValue({ fieldId: 'subsidiary' }) });
        assetRecord.setValue({ fieldId: 'custrecord_assetlocation', value: itemReceipt.getValue({ fieldId: 'location' }) });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrn', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_grandparent_transaction', value: transferLocationAsset.grandparent });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrnline', value: line });
        assetRecord.setValue({ fieldId: 'custrecord_asset_item', value: item });
        assetRecord.setValue({ fieldId: 'custrecord_assetlifeunits', value: transferLocationAsset.custrecord_assetlifeunits });
        assetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: quantity });
        assetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: quantity });
        assetRecord.setValue({ fieldId: 'custrecord_assetstatus', value: 2 });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrency', value: transferLocationAsset.custrecord_assetcurrency });
        assetRecord.setValue({ fieldId: 'custrecord_assetpurchasedate', value: transferLocationAsset.custrecord_assetpurchasedate });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrentage', value: transferLocationAsset.custrecord_assetcurrentage });
        assetRecord.setValue({ fieldId: 'custrecord_assetlastdeprdate', value: transferLocationAsset.custrecord_assetlastdeprdate });
        assetRecord.setValue({ fieldId: 'custrecord_assetdeprrules', value: 1 });
        assetRecord.setValue({ fieldId: 'custrecord_assetrevisionrules', value: 1 });
        assetRecord.setValue({ fieldId: 'custrecord_assetdepractive', value: 1 });

        var depreciationStartDate = assetRecord.getValue({ fieldId: 'custrecord_assetdeprstartdate' });
        if (depreciationStartDate) {
            assetRecord.setValue({ fieldId: 'custrecord_assetdeprstartdate', value: transferLocationAsset.custrecord_assetdeprstartdate });
        } else {
            var today = new Date();
            assetRecord.setValue({ fieldId: 'custrecord_assetdeprstartdate', value: today });
        }

        var assetRecordId = assetRecord.save();
        log.debug('Asset record created', 'Asset record ID: ' + assetRecordId);

        var assetDetails = {}; // Build asset details based on asset fields and quantity
        assetDetails.itemReceiptId = itemReceipt.id;
        assetDetails.newLocation = location;
        assetDetails.newQuantity = quantity;
        assetDetails.newValue = updatedCost;
        assetDetails.assetId = assetRecordId
        createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, 'Created');
    }

    function findOrCreateMonthlyChangesRecord(date) {
        // Format the month and year for the search
        var month = date.getMonth() + 1; // Months are zero-indexed
        var year = date.getFullYear();
        month = month < 10 ? '0' + month : month; // Format as MM

        // Search for an existing Monthly Asset Changes record for the month/year
        var changesRecordSearch = search.create({
            type: 'customrecord_monthly_asset_changes',
            filters: [['name', 'contains', month + ' ' + year]],
            columns: ['internalid']
        });

        var changesRecordResult = changesRecordSearch.run().getRange({ start: 0, end: 1 });
        var changesRecordId;

        if (changesRecordResult.length > 0) {
            // Existing record found
            changesRecordId = changesRecordResult[0].getValue('internalid');
            log.debug('Monthly Changes Record Found', 'ID: ' + changesRecordId);
        } else {
            // No record found, create a new one
            var changesRecord = record.create({ type: 'customrecord_monthly_asset_changes', isDynamic: true });
            changesRecord.setValue('name', 'Changes for ' + month + ' ' + year);
            changesRecordId = changesRecord.save();
            log.debug('Monthly Changes Record Created', 'ID: ' + changesRecordId);
        }

        return changesRecordId;
    }

    function createMonthlyAssetChangeSubRecord(assetDetails, changesRecordId, method) {
        var subRecord = record.create({ type: 'customrecord_monthly_asset_changes_sub', isDynamic: true });

        // Populate sub-record fields
        subRecord.setValue('custrecord_asset_changes_parent', changesRecordId);
        subRecord.setValue('custrecord_fam_asset_changes', assetDetails.assetId);
        subRecord.setValue('custrecordasset_change_old_location', assetDetails.oldLocation);
        subRecord.setValue('custrecord_asset_change_new_location', assetDetails.newLocation);
        subRecord.setValue('custrecord_asset_change_old_qty', assetDetails.oldQuantity);
        subRecord.setValue('custrecord_asset_change_new_qty', assetDetails.newQuantity);
        subRecord.setValue('custrecord_previous_value_changes', assetDetails.oldValue);
        subRecord.setValue('custrecord_new_value_changes', assetDetails.newValue);
        subRecord.setValue('custrecord_item_receipt_changes', assetDetails.itemReceiptId);
        subRecord.setValue('custrecord_method_changes', method);

        var subRecordId = subRecord.save();
        log.debug('Monthly Asset Changes Sub-Record Created', 'ID: ' + subRecordId);

        return subRecordId;
    }

    function sendEmail(unmatchedSerialNumbers, insufficientQuantityItems, itemReceipt) {
        var recipients = getEmailRecipients();
        var tranID = itemReceipt.getValue({ fieldId: 'tranid' });
        var emailBody = "";

        if (unmatchedSerialNumbers.length > 0) {
            emailBody += 'Dear financial controller,\n\n' +
                'The Asset Management script was recently run on Item Receipt ID: ' + tranID + ' and was unable to locate fixed asset records for the following items and serial numbers:\n';

            unmatchedSerialNumbers.forEach(function (entry) {
                emailBody += entry.itemName + ', ' + entry.serialNumber + '\n';
            });

            emailBody += '\nPlease investigate the results and make sure fixed asset records are created or updated with the necessary tracking information.\n\n';
        }

        if (insufficientQuantityItems.length > 0) {
            emailBody += 'Dear financial controller,\n\n' +
                'The Asset Management script was recently run on Item Receipt ID: ' + tranID + ' and was unable to locate enough quantity of fixed assets to complete the transfer of assets. Please investigate the results for the following items and serial numbers:\n';

            insufficientQuantityItems.forEach(function (entry) {
                emailBody += entry.itemName + ', ' + entry.serialNumber + '\n';
            });

            emailBody += '\nPlease ensure sufficient asset records and quantities exist in the correct locations.\n\n';
        }

        // Only send email if there is content to send
        if (emailBody) {
            email.send({
                author: -5, // -5 sets the author to be the system
                recipients: recipients,
                subject: 'Asset Management Script Notification',
                body: emailBody
            });
        }
    }

    function getEmailRecipients() {
        var recipients = [];
        var roleSearch = search.create({
            type: search.Type.EMPLOYEE,
            filters: [
                ["role", "anyof", ["1042", "1044"]]
            ],
            columns: ["email"]
        });

        roleSearch.run().each(function (result) {
            recipients.push(result.getValue("email"));
            return true;
        });

        return recipients;
    }

    return {
        execute: execute
    };
});