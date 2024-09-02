/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

define(['N/record', 'N/search', 'N/log', 'N/task'], function (record, search, log, task) {

    function afterSubmit(context) {

        if (context.type === context.UserEventType.DELETE) {
            return;
        }

        // Load the item receipt
        var newRecord = context.newRecord;
        var oldRecord = context.oldRecord;
        var itemReceipt = record.load({
            type: record.Type.ITEM_RECEIPT,
            id: newRecord.id,
            isDynamic: false
        });

        var isCreated = (context.type === context.UserEventType.CREATE);
        var isUpdated = (context.type === context.UserEventType.EDIT);
        var createdFrom = itemReceipt.getValue({ fieldId: 'createdfrom' });
        var subsidiary = itemReceipt.getValue({ fieldId: 'subsidiary' });
        log.debug('Script started', 'Script started for ' + itemReceipt + ' created from ' + createdFrom + ' by Subsidiary ' + subsidiary);
       
        // Check for valid subsidiary
        // 7 = Siera Leone, 8 = Liberia, 9 = Nigeria, 14 = DRC, 21 = Test Nigeria
        var validSubsidiaries = ["7", "8", "9", "14", "21"];
        if (validSubsidiaries.indexOf(subsidiary) === -1) {
            log.debug('Invalid Subsidiary', 'This script only runs for subsidiaries: 7, 8, 9, 14 or 21. The subsidiary in this item receipt is ' + subsidiary + '.');
            return;
        }

        // Check the source transaction type (PurchOrd or TrnfrOrd)
        var createdFrom = itemReceipt.getValue({ fieldId: 'createdfrom' });
        var sourceType = search.lookupFields({
            type: search.Type.TRANSACTION,
            id: createdFrom,
            columns: ['type']
        }).type[0].value;

        if (isCreated) {
            if (sourceType === 'PurchOrd') {
                handlePurchaseOrder(itemReceipt);
            } else if (sourceType === 'TrnfrOrd') {
                handleTransferOrder(itemReceipt);
            } else {
                log.debug('Purchase type not identified. Source type is: ' + sourceType);
            }
        }

        // If updated, check if specific fields have been modified
        if (isUpdated) {
            var fieldsToCheck = [
                'landedcostamount6',
                'landedcostamount7',
                'landedcostamount8',
                'landedcostamount9',
                'landedcostamount10'
            ];

            var fieldsToIgnore = [
                'recmachcustrecord_2663_transactionorigtypes', 'itemlabels',
                'recmachcustrecord_mobile_target_transactionloaded', 'recmachcustrecord_far_expinc_transactiondotted',
                'iteminventorydetailtypes', 'recmachcustrecord_deprhistjournaltypes', 'recmachcustrecord_far_expinc_transactionloaded',
                'custpage_scm_lc_elcenabled', 'submitted', 'messagesdotted', 'recmachcustrecord2parents', 'nlapiCC',
                'expensevalid', 'callsloaded', 'recmachcustrecord2origtypes', 'nlapiSR', 'tasksloaded',
                'clickedback', 'nlapiPS', 'recmachcustrecord_2663_transactionvalid', 'expenselabels', 'prevdate',
                'recmachcustrecord_4599_tranchild_joindotted', 'recmachcustrecord1fieldsets', 'contactsdotted',
                'inpt_custbody_project_type', 'recmachcustrecord2labels', 'tasksdotted', 'recmachcustrecord_summary_histjournaldotted',
                'itemlandedcosttypes', 'recmachcustrecord_deprhistjournalparents', 'eventsloaded', 'callsdotted', 'inpt_postingperiod',
            ];

            var fieldsModified = fieldsToCheck.some(function (fieldId) {
                var newValue = newRecord.getValue(fieldId);
                var oldValue = oldRecord.getValue(fieldId);
                log.debug('Field Value Check', 'Field: ' + fieldId + ', Old Value: ' + oldValue + ', New Value: ' + newValue);
                return newValue !== oldValue;
            });

            if (fieldsModified) {
                handleLandedCost(newRecord.id);
            } else {
                var allFields = newRecord.getFields();
                var changes = [];

                allFields.forEach(function (fieldId) {
                    if (fieldsToCheck.indexOf(fieldId) === -1 && fieldsToIgnore.indexOf(fieldId) === -1) { // Using indexOf instead of includes
                        var newValue = newRecord.getValue(fieldId);
                        var oldValue = oldRecord.getValue(fieldId);
                        if (newValue !== oldValue) {
                            changes.push('Field: ' + fieldId + ', Old Value: ' + oldValue + ', New Value: ' + newValue);
                        }
                    }
                });

                if (changes.length > 0) {
                    log.debug('Updated with other changes', 'The record' + newRecord.id + ' was updated and changes were found in other fields: ' + changes.join(', '));
                } else {
                    log.debug('Updated but no Change', 'The record was updated but no valid fields related to any asset records were changed.');
                }
            }
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
    }

    function handleLandedCost(itemReceiptId) {
        log.debug('Handling Landed Cost', 'Item Receipt ID: ' + itemReceiptId);

        // Load the item receipt
        var itemReceipt = record.load({
            type: record.Type.ITEM_RECEIPT,
            id: itemReceiptId,
            isDynamic: false
        });

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

        // Calculate total value of each line item
        for (var i = 0; i < itemCount; i++) {
            var quantity = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
            var rate = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
            var amount = (quantity * rate) * exchangeRate;

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
                        'custrecord_asset_quantity',
                        'custrecord_assetcost',
                        'custrecord_assetcurrentcost',
                        'custrecord_assetbookvalue'
                    ]
                });

                var assetResults = assetSearch.run().getRange({ start: 0, end: 1000 });

                assetResults.forEach(function (result) {
                    var assetId = result.getValue({ name: 'internalid' });
                    var assetQuantity = parseFloat(result.getValue({ name: 'custrecord_asset_quantity' })) || 0;
                    var newCost = assetQuantity * (newAmount / quantity);

                    var assetRecord = record.load({
                        type: 'customrecord_ncfar_asset',
                        id: assetId,
                        isDynamic: true
                    });

                    assetRecord.setValue({ fieldId: 'custrecord_assetcost', value: newCost });
                    assetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: newCost });
                    assetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: newCost });

                    assetRecord.save();
                });
            }
        }
    }

    function handlePurchaseOrder(itemReceipt) {
        log.debug('Purchase Order');
        // Handle the creation of new asset records
        var itemCount = itemReceipt.getLineCount({ sublistId: 'item' });
        var exchangeRate = getExchangeRate(itemReceipt.getValue({ fieldId: 'subsidiary' }), itemReceipt);
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
            '1265': { type: '111', method: '3', residual: 0.0, lifetime: 36 }
        };

        for (var i = 0; i < itemCount; i++) {
            var item = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

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
                    createAssetRecord(itemReceipt, i, j, assetMapping[assetAccount], inventoryDetailSubrecord, exchangeRate, receivedCost);
                }
            }
        }
    }

    function createAssetRecord(itemReceipt, line, inventoryLine, mapping, inventoryDetailSubrecord, exchangeRate, receivedCost) {
        var assetRecord = record.create({
            type: 'customrecord_ncfar_asset',
            isDynamic: true
        });

        // Populate the asset record fields based on the mapping and item receipt data
        assetRecord.setValue({ fieldId: 'custrecord_assettype', value: mapping.type });
        assetRecord.setValue({ fieldId: 'custrecord_assetaccmethod', value: mapping.method });
        assetRecord.setValue({ fieldId: 'custrecord_assetresidualvalue', value: mapping.residual });
        assetRecord.setValue({ fieldId: 'custrecord_assetlifetime', value: mapping.lifetime });

        // Set other fields
        var item = itemReceipt.getSublistValue({ sublistId: 'item', fieldId: 'item', line: line });
        var displayName = search.lookupFields({ type: search.Type.ITEM, id: item, columns: ['displayname'] }).displayname;

        var serialNumber = inventoryDetailSubrecord.getSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'receiptinventorynumber',
            line: inventoryLine
        });

        assetRecord.setValue({ fieldId: 'altname', value: displayName });
        assetRecord.setValue({ fieldId: 'custrecord_assetdescr', value: "This asset was automatically generated by Sam’s Asset Creation Script" });
        assetRecord.setValue({ fieldId: 'custrecord_assetserialno', value: serialNumber });
        assetRecord.setValue({ fieldId: 'custrecord_assetsubsidiary', value: itemReceipt.getValue({ fieldId: 'subsidiary' }) });
        assetRecord.setValue({ fieldId: 'custrecord_assetlocation', value: itemReceipt.getValue({ fieldId: 'location' }) });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrn', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_grandparent_transaction', value: itemReceipt.id });
        assetRecord.setValue({ fieldId: 'custrecord_assetsourcetrnline', value: line });
        assetRecord.setValue({ fieldId: 'custrecord_asset_item', value: item });
        var today = new Date();
        assetRecord.setValue({ fieldId: 'custrecord_assetpurchasedate', value: today });
        assetRecord.setValue({ fieldId: 'custrecord_assetdeprrules', value: 1 });
        assetRecord.setValue({ fieldId: 'custrecord_assetrevisionrules', value: 1 });

        var itemDetailQty = inventoryDetailSubrecord.getSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'quantity',
            line: inventoryLine
        });

        // Calculate asset value and set currency

        var assetValue = (receivedCost * itemDetailQty) * exchangeRate;
        assetRecord.setValue({ fieldId: 'custrecord_assetcost', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: assetValue });
        assetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: itemDetailQty });
        assetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: itemDetailQty });

        var subsidiary = itemReceipt.getValue({ fieldId: 'subsidiary' });
        var currencyMapping = {
            '1': '1', // UK - GBP
            '7': '6', // Sierra Leone - Sierra Leonean Leones
            '8': '7', // Liberia - Liberian Dollars
            '9': '8', // Nigeria - Nira
            '21': '8', // Test NG - Nira
            '14': '9' // DRC - Congolese Francs
        };

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

                if (billDate) {
                    dateToUse = new Date(billDate);
                }
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

        var formattedDate = formatDate(dateToUse);
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
        log.debug('Transfer Order');
        var itemCount = itemReceipt.getLineCount({ sublistId: 'item' });

        // Define the asset mapping
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
            '1265': { type: '111', method: '3', residual: 0.0, lifetime: 36 }
        };

        for (var i = 0; i < itemCount; i++) {
            var item = itemReceipt.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var inventoryDetailSubrecord = itemReceipt.getSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail',
                line: i
            });

            var inventoryAssignmentCount = inventoryDetailSubrecord ? inventoryDetailSubrecord.getLineCount({ sublistId: 'inventoryassignment' }) : 0;

            // Lookup asset account for the item
            var assetAccount = search.lookupFields({
                type: search.Type.ITEM,
                id: item,
                columns: ['assetaccount']
            }).assetaccount[0].value;

            // Check if the asset account is in the asset mapping
            if (!assetMapping[assetAccount]) {
                continue; // Skip processing this item
            }

            for (var j = 0; j < inventoryAssignmentCount; j++) {
                var serialNumber = inventoryDetailSubrecord.getSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'receiptinventorynumber',
                    line: j
                });

                if (!serialNumber) {
                    log.debug('Error', 'No serial/lot number for ' + item)
                    continue;
                }

                var quantity = inventoryDetailSubrecord.getSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    line: j
                });

                var location = itemReceipt.getValue({ fieldId: 'location' });
                var transferLocation = itemReceipt.getValue({ fieldId: 'transferlocation' });

                var existingAssetSearch = search.create({
                    type: 'customrecord_ncfar_asset',
                    filters: [
                        ['custrecord_assetserialno', 'is', serialNumber],
                        'AND',
                        ['custrecord_assetlocation', 'anyof', [location, transferLocation]]
                    ],
                    columns: [
                        'internalid',
                        'custrecord_asset_quantity',
                        'custrecord_assetcost',
                        'custrecord_assetcurrentcost',
                        'custrecord_assetbookvalue',
                        'custrecord_assetlocation',
                        'custrecord_assetserialno',
                        'custrecord_asset_item',
                        'custrecord_grandparent_transaction'
                    ]
                });

                var matchingAssets = [];
                existingAssetSearch.run().each(function (result) {
                    var quantity = parseInt(result.getValue('custrecord_asset_quantity'), 10);

                    if (isNaN(quantity)) {
                        log.error('Invalid Quantity', 'Asset ID: ' + result.getValue('internalid') + ', Quantity: ' + result.getValue('custrecord_asset_quantity'));
                        return true; // Skip this result and continue processing
                    }

                    var assetDetails = {
                        id: result.getValue('internalid'),
                        serialNumber: result.getValue('custrecord_assetserialno'),
                        item: result.getValue('custrecord_asset_item'),
                        quantity: quantity,
                        cost: parseFloat(result.getValue('custrecord_assetcost')),
                        currentCost: parseFloat(result.getValue('custrecord_assetcurrentcost')),
                        bookValue: parseFloat(result.getValue('custrecord_assetbookvalue')),
                        location: result.getValue('custrecord_assetlocation'),
                        grandparent: result.getValue('custrecord_grandparent_transaction')
                    };

                    matchingAssets.push(assetDetails);

                    return true; // Continue processing
                });

                if (matchingAssets.length === 0) {
                    log.debug('No asset records for either location found.', 'Investigate results for serial number: ' + serialNumber);
                    break;
                }

                var locationAsset = null;
                var transferLocationAsset = null;

                for (var k = 0; k < matchingAssets.length; k++) {
                    if (matchingAssets[k].location === location) {
                        locationAsset = matchingAssets[k];
                    }
                    if (matchingAssets[k].location === transferLocation) {
                        transferLocationAsset = matchingAssets[k];
                    }
                }

                // assert with an error for tansferquantity < quantity and other edge cases
                if (!locationAsset && transferLocationAsset) {
                    if (transferLocationAsset.quantity > quantity) {
                        log.debug('No asset at location. Transferlocation moving partial stock. Reduce existing asset and create new.')
                        updateAssetQuantity(transferLocationAsset, transferLocationAsset.quantity - quantity);
                        createNewAsset(itemReceipt, i, j, assetMapping[assetAccount], inventoryDetailSubrecord, quantity, location, transferLocationAsset, locationAsset);
                        updateAssetValue(transferLocationAsset, quantity);

                    } else {
                        log.debug('No asset at location. Transferlocation moving all stock. Updating asset location.')
                        updateAssetLocation(transferLocationAsset, location, itemReceipt);
                    }
                } else if (locationAsset && transferLocationAsset) {
                    if (quantity < transferLocationAsset.quantity) {
                        log.debug('Assets at both locations. Transferlocation moving partial inventory. Merge Partial Inventory.')
                        updateAssetQuantity(transferLocationAsset, transferLocationAsset.quantity - quantity);
                        updateAssetQuantity(locationAsset, locationAsset.quantity + quantity);
                        updateAssetValues(locationAsset, transferLocationAsset, quantity);
                    } else {
                        log.debug('Assets at both locations. Transferlocation moving all inventory. Merge Assets to new location.')
                        mergeAssets(locationAsset, transferLocationAsset);
                    }
                } else if (!transferLocationAsset) {
                    log.debug('Error.', 'No asset at transfer location for item ' + 'Investigate results for serial number: ' + serialNumber + 'from ' + location)
                }
            }
        }
    }

    function updateAssetQuantity(asset, newQuantity) {
        var assetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: asset.id,
            isDynamic: true
        });
        assetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: newQuantity });
        assetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: newQuantity });

        assetRecord.save();
    }

    function updateAssetLocation(asset, newLocation, itemReceipt) {
        var assetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: asset.id,
            isDynamic: true
        });

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
    }

    function updateAssetValue(transferLocationAsset, quantity) {
        var updatedCost = (transferLocationAsset.cost / transferLocationAsset.quantity) * quantity;
        var updatedCurrentCost = (transferLocationAsset.currentCost / transferLocationAsset.quantity) * quantity;
        var updatedBookValue = (transferLocationAsset.bookValue / transferLocationAsset.quantity) * quantity;

        // Load the transfer location asset record
        var transferLocationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: transferLocationAsset.id,
            isDynamic: true
        });

        // Update transfer location asset record values
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: transferLocationAsset.cost - updatedCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: transferLocationAsset.currentCost - updatedCurrentCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: transferLocationAsset.bookValue - updatedBookValue });
        transferLocationAssetRecord.save();
    }

    function updateAssetValues(locationAsset, transferLocationAsset, quantity) {
        var updatedCost = (transferLocationAsset.cost / transferLocationAsset.quantity) * quantity;
        var updatedCurrentCost = (transferLocationAsset.currentCost / transferLocationAsset.quantity) * quantity;
        var updatedBookValue = (transferLocationAsset.bookValue / transferLocationAsset.quantity) * quantity;

        // Load the location asset record
        var locationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: locationAsset.id,
            isDynamic: true
        });

        // Update location asset record values
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: locationAsset.cost + updatedCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: locationAsset.currentCost + updatedCurrentCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: locationAsset.bookValue + updatedBookValue });
        locationAssetRecord.save();

        // Load the transfer location asset record
        var transferLocationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: transferLocationAsset.id,
            isDynamic: true
        });

        // Update transfer location asset record values
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: transferLocationAsset.cost - updatedCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: transferLocationAsset.currentCost - updatedCurrentCost });
        transferLocationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: transferLocationAsset.bookValue - updatedBookValue });
        transferLocationAssetRecord.save();
    }

    function mergeAssets(locationAsset, transferLocationAsset) {
        var mergedQuantity = locationAsset.quantity + transferLocationAsset.quantity;
        var mergedCost = locationAsset.cost + transferLocationAsset.cost;
        var mergedCurrentCost = locationAsset.currentCost + transferLocationAsset.currentCost;
        var mergedBookValue = locationAsset.bookValue + transferLocationAsset.bookValue;

        var locationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: locationAsset.id,
            isDynamic: true
        });

        locationAssetRecord.setValue({ fieldId: 'custrecord_asset_quantity', value: mergedQuantity });
        locationAssetRecord.setValue({ fieldId: 'custrecord_ncfar_quantity', value: mergedQuantity });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcost', value: mergedCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetcurrentcost', value: mergedCurrentCost });
        locationAssetRecord.setValue({ fieldId: 'custrecord_assetbookvalue', value: mergedBookValue });
        locationAssetRecord.save();

        var transferLocationAssetRecord = record.load({
            type: 'customrecord_ncfar_asset',
            id: transferLocationAsset.id,
            isDynamic: true
        });

        transferLocationAssetRecord.setValue({ fieldId: 'isinactive', value: true });
        transferLocationAssetRecord.save();
    }

    function createNewAsset(itemReceipt, line, inventoryLine, mapping, inventoryDetailSubrecord, quantity, location, transferLocationAsset, locationAsset) {
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
        var displayName = search.lookupFields({ type: search.Type.ITEM, id: item, columns: ['displayname'] }).displayname;
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
    }

    return {
        afterSubmit: afterSubmit
    };

});