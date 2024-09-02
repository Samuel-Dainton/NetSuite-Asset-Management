/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log', 'N/error'], function (record, search, log, error) {

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT && context.type !== context.UserEventType.DELETE) {
            return;
        }
        log.debug('Script Started', 'Script Started');
        if (context.type === context.UserEventType.DELETE) {
            log.debug('Deletion Event', 'Proceeding to deletePairedRecords function.');
            deletePairedRecords(context);
            return;
        }
        var newRecord = context.newRecord;
        var accountId = "1468"; // Internal ID for account 6323
        var iaAccount = newRecord.getValue('account');
        var iaTotal = newRecord.getValue('estimatedtotalvalue');

        var inventoryAdjustment = record.load({
            type: record.Type.INVENTORY_ADJUSTMENT,
            id: context.newRecord.id,
            isDynamic: true
        });

        // Trigger only if the IA credits account 6323 and the total is negative (indicating items are removed)
        if (iaAccount === accountId && iaTotal <= 0) {
            var journalId = createReversalJournal(inventoryAdjustment);
            var madRecordId = updateOrCreateMADRecord(inventoryAdjustment);
            log.debug('Related Records', 'journalId ' + journalId + ' madRecordId ' + madRecordId);

            // After the operations, update the fields and save the record once
            inventoryAdjustment.setValue('custbody_ia_reversal_journal', journalId);
            inventoryAdjustment.setValue('custbody_mad_reference', madRecordId);
            inventoryAdjustment.save(); // Save the record with the updated fields

        } else {
            log.debug('Checks Failed', 'Looking for ' + accountId + ' but got ' + iaAccount + ' and a total < 0 but got ' + iaTotal);
        }
    }

    // A journal needs to be created to reverse the financial effects of the inventory adjustment. We don't want the IA to dispose of 
    // the value of the items, we want the Asset Disposal process to do that as it takes into accoutn the true value of the item, including depreciation.
    function createReversalJournal(inventoryAdjustment) {
        try {
            var existingJournalId = inventoryAdjustment.getValue('custbody_ia_reversal_journal');
            var subsidiary = inventoryAdjustment.getValue('subsidiary');
            if (existingJournalId) {
                journalEntry = record.load({
                    type: record.Type.JOURNAL_ENTRY,
                    id: existingJournalId,
                    isDynamic: true
                });
                var lineCount = journalEntry.getLineCount({ sublistId: 'line' });
                for (var i = lineCount - 1; i >= 0; i--) {
                    journalEntry.removeLine({
                        sublistId: 'line',
                        line: i
                    });
                }
            } else {
                journalEntry = record.create({
                    type: record.Type.JOURNAL_ENTRY,
                    isDynamic: true
                });
                journalEntry.setValue('subsidiary', subsidiary);
            }

            var postingPeriod = inventoryAdjustment.getValue('postingperiod');
            var currencyMapping = {
                '1': '1', // UK - British Pound
                '15': '5', // China - Chinese Yuan
                '7': '6', // Sierra Leone - Sierra Leonean Leones
                '8': '7', // Liberia - Liberian Dollars
                '9': '8', // Nigeria - Nira
                '21': '8', // Test NG - Nira
                '14': '9' // DRC - Congolese Francs
            };
            var currency = currencyMapping[subsidiary];
            var memo = "This Journal was automatically created by Sam's script to reverse the impact of Inventory Adjustment: " + inventoryAdjustment.id + " for the purpose of item disposal.";
            var systemUserId = 5574;
            var iaAccount = inventoryAdjustment.getValue('account');
            var iaTotal = inventoryAdjustment.getValue('estimatedtotalvalue');

            journalEntry.setValue('postingperiod', postingPeriod);
            journalEntry.setValue('currency', currency);
            journalEntry.setValue('memo', memo);
            journalEntry.setValue('custbody3', systemUserId); // Set system user as 'Order approved by'
            journalEntry.setValue('custbody_created_by', systemUserId);

            // Credit the IA account to reverse the adjustment
            journalEntry.selectNewLine({ sublistId: 'line' });
            journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: iaAccount });
            journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: Math.abs(iaTotal) });
            journalEntry.commitLine({ sublistId: 'line' });

            // Debit the asset account for each line item
            var lineCount = inventoryAdjustment.getLineCount({ sublistId: 'inventory' });
            var totalDebits = 0;
            for (var i = 0; i < lineCount; i++) {
                var itemId = inventoryAdjustment.getSublistValue({ sublistId: 'inventory', fieldId: 'item', line: i });
                // Perform a search to get the item type
                var itemType;
                var itemSearch = search.create({
                    type: search.Type.ITEM,
                    filters: [
                        ['internalid', 'is', itemId]
                    ],
                    columns: ['type']
                });

                itemSearch.run().each(function (result) {
                    itemType = result.getValue('type');
                    return false; // Stop after first result
                });

                if (!itemType) {
                    var itemName = currentRecord.getCurrentSublistText({
                        sublistId: 'inventory',
                        fieldId: 'item'
                    });

                    // Show an error message if item type could not be determined
                    var myMsg = message.create({
                        title: "Error",
                        message: "Unable to determine item type for " + itemName,
                        type: message.Type.ERROR
                    });
                    myMsg.show();

                    return false; // Prevent the user from saving the line
                }

                // Determine record type based on itemType
                var recordType;
                if (itemType === 'InvtPart') {
                    recordType = record.Type.INVENTORY_ITEM;
                } else if (itemType === 'Assembly') {
                    recordType = record.Type.ASSEMBLY_ITEM;
                } else {
                    var itemName = currentRecord.getCurrentSublistText({
                        sublistId: 'inventory',
                        fieldId: 'item'
                    });

                    throw error.create({
                        name: "Invalid Item Type",
                        message: itemName + " is not a valid fixed asset item type. It is " + itemType,
                        notifyOff: false
                    });
                }

                // Load the item record
                var itemRecord = record.load({
                    type: recordType,
                    id: itemId
                });

                var assetAccount = itemRecord.getValue('assetaccount')
                var quantity = inventoryAdjustment.getSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: i });
                var unitCost = inventoryAdjustment.getSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: i });
                var debitAmount = unitCost * quantity;

                totalDebits += debitAmount;

                journalEntry.selectNewLine({ sublistId: 'line' });
                journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: assetAccount });
                journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: -debitAmount });  // Set debit as a negative value
                journalEntry.commitLine({ sublistId: 'line' });
            }

            // Calculate the rounding difference
            var roundingDifference = totalDebits - iaTotal;

            // Add a rounding difference line if needed
            if (roundingDifference !== 0) {
                journalEntry.selectNewLine({ sublistId: 'line' });
                journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: 237 });
                if (roundingDifference > 0) {
                    journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit', value: roundingDifference });  // Credit the positive difference
                    totalDebits -= roundingDifference; // Adjust totalDebits by subtracting the positive rounding difference
                } else {
                    journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit', value: roundingDifference });  // Debit the negative difference
                    totalDebits += roundingDifference; // Adjust totalDebits by adding the negative rounding difference
                }
                journalEntry.setCurrentSublistValue({ sublistId: 'line', fieldId: 'memo', value: 'Rounding Difference' });
                journalEntry.commitLine({ sublistId: 'line' });

                // Log the rounding difference
                log.debug('Rounding Difference', 'Rounding Difference Amount: ' + roundingDifference);
            }

            // Log the total amounts including rounding differences
            log.debug('Total Amounts', 'Total Debits (including rounding): ' + -totalDebits + ', Total Credits (including rounding): ' + iaTotal);

            var journalId = journalEntry.save();
            log.debug('Journal Entry Created', 'IA: ' + inventoryAdjustment.id + ', Journal: ' + journalId);
            return journalId;
        } catch (e) {
            log.error('Error creating journal entry', e);
            throw error.create({
                name: 'JOURNAL_CREATION_ERROR',
                message: 'An error occurred while creating the reversal journal: ' + e.message,
                notifyOff: false
            });
        }
    }

    // Monthly Asset Disposal record is a record used to store the details of all of these disposed items, so that they can be put through 
    // NetSuites Asset Disposal process at the end of each month by finance.
    function updateOrCreateMADRecord(inventoryAdjustment) {
        try {
            var madReference = inventoryAdjustment.getValue('custbody_mad_reference');
            if (madReference) {
                // Delete existing customrecord_asset_disposal_sublist records with the current IA ID
                deleteExistingMADRecords(inventoryAdjustment.id);
            }

            var iaDate = inventoryAdjustment.getValue('trandate');
            var month = iaDate.getMonth() + 1; // JavaScript months are 0-based, so add 1
            var year = iaDate.getFullYear();
            month = month < 10 ? '0' + month : month; // Ensure two-digit month

            // Search for existing MAD record using month and year
            var madSearch = search.create({
                type: 'customrecord_monthly_asset_disposal',
                filters: [
                    ['name', 'is', 'Disposals for ' + month + ' ' + year]
                ],
                columns: ['internalid']
            });

            var madSearchResults = madSearch.run().getRange({ start: 0, end: 1 });
            var madRecordId;

            if (!madSearchResults || madSearchResults.length === 0) {
                // No MAD record found, create a new one
                var madRecord = record.create({
                    type: 'customrecord_monthly_asset_disposal',
                    isDynamic: true
                });

                madRecord.setValue('name', 'Disposals for ' + month + ' ' + year);
                madRecordId = madRecord.save(); // Save the new record and get the ID
                log.debug('MAD Record Created', 'MAD Record ID: ' + madRecordId);
            } else {
                // Existing MAD record found, retrieve its ID
                madRecordId = madSearchResults[0].getValue({ name: 'internalid' });
                log.debug('MAD Record Found', 'MAD Record ID: ' + madRecordId);
            }

            var lineCount = inventoryAdjustment.getLineCount({ sublistId: 'inventory' });
            var searchFilters = [];
            var lineItems = {};

            for (var i = 0; i < lineCount; i++) {
                var itemId = inventoryAdjustment.getSublistValue({ sublistId: 'inventory', fieldId: 'item', line: i });
                var location = inventoryAdjustment.getSublistValue({ sublistId: 'inventory', fieldId: 'location', line: i });

                inventoryAdjustment.selectLine({ sublistId: 'inventory', line: i });

                if (inventoryAdjustment.hasCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' })) {
                    var inventoryDetail = inventoryAdjustment.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
                    var inventoryDetailCount = inventoryDetail.getLineCount({ sublistId: 'inventoryassignment' });

                    for (var j = 0; j < inventoryDetailCount; j++) {
                        var quantity = inventoryDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: j });
                        var serialOrLotNumId = inventoryDetail.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: j });

                        var serialOrLotRecord = record.load({
                            type: 'inventorynumber',
                            id: serialOrLotNumId
                        });

                        // We need the quantity from the IA and not the asset record we are searching for. However, if we search for items 1, 2 and 3, the search
                        // results may come back in the order 3, 1, 2 or any other combination. So we are creating a unique key to pair each search to a particular
                        // result, so that we can add the correct details to the MAD records.
                        var serialOrLotNumText = serialOrLotRecord.getValue('inventorynumber');
                        var uniqueKey = itemId + '-' + location + '-' + serialOrLotNumText;

                        lineItems[uniqueKey] = {
                            quantity: quantity,
                            itemId: itemId,
                            location: location,
                            serialOrLotNum: serialOrLotNumText
                        };

                        log.debug('Generated Unique Key', uniqueKey + ': ' + JSON.stringify(lineItems[uniqueKey]));

                        searchFilters.push([
                            ['custrecord_assetserialno', 'is', serialOrLotNumText],
                            'AND',
                            ['custrecord_assetlocation', 'is', location]
                        ]);
                    }
                } else {
                    log.error('Inventory Detail Missing', 'Inventory Detail subrecord not found for Line: ' + i);
                }
            }

            log.debug('Line Items Object', JSON.stringify(lineItems));

            var assetSearch = search.create({
                type: 'customrecord_ncfar_asset',
                filters: [
                    searchFilters.reduce(function (acc, val) {
                        return acc.length > 0 ? acc.concat(['OR'], val) : val;
                    }, [])
                ],
                columns: [
                    'internalid',
                    'name',
                    'custrecord_assetserialno',
                    'custrecord_assetlocation',
                    'custrecord_asset_item'
                ]
            });

            var assetSearchResults = assetSearch.run().getRange({ start: 0, end: 1000 });
            var processedLotLocationCombos = {};
            var foundItems = {};

            for (var i = 0; i < assetSearchResults.length; i++) {
                var assetRecord = assetSearchResults[i];
                var famRecordName = assetRecord.getValue({ name: 'name' });
                var serialOrLotNum = assetRecord.getValue({ name: 'custrecord_assetserialno' });
                var item = assetRecord.getValue({ name: 'custrecord_asset_item' });
                var location = assetRecord.getValue({ name: 'custrecord_assetlocation' });
                var uniqueKey = item + '-' + location + '-' + serialOrLotNum;

                // Make sure we are not processing Asset records with the same lot number and location.
                var comboKey = location + '-' + serialOrLotNum;
                if (processedLotLocationCombos[comboKey]) {
                    log.debug('Skipping Duplicate', 'Skipping record for: ' + uniqueKey + ' because it has already been processed.');
                    continue;
                }

                log.debug('Processing Asset Search Result', 'Unique Key: ' + uniqueKey);

                var lineItem = lineItems[uniqueKey];

                if (lineItem) {
                    var disposalSublistRecord = record.create({
                        type: 'customrecord_asset_disposal_sublist',
                        isDynamic: true
                    });

                    disposalSublistRecord.setValue('custrecord_fam_asset', famRecordName);
                    disposalSublistRecord.setValue('custrecord_asset_location', location);
                    disposalSublistRecord.setValue('custrecord_item', item);
                    disposalSublistRecord.setValue('custrecord_quantity', lineItem.quantity);
                    disposalSublistRecord.setValue('custrecord_serial_or_lot_num', serialOrLotNum);
                    disposalSublistRecord.setValue('custrecord_date', iaDate);
                    disposalSublistRecord.setValue('custrecord_fam_record', madRecordId);
                    log.debug('Inventory Adjustment ID', inventoryAdjustment.id);
                    disposalSublistRecord.setValue('custrecord_inventory_adjustment_link', inventoryAdjustment.id);
                    disposalSublistRecord.setValue('custrecord_inventory_adjustment_ref', inventoryAdjustment.id);

                    var sublistRecordId = disposalSublistRecord.save();
                    foundItems[uniqueKey] = true;
                    log.debug('Asset Disposal Sublist Record Created', 'Sublist Record ID: ' + sublistRecordId);

                    processedLotLocationCombos[comboKey] = true;
                } 
            }

            for (var uniqueKey in lineItems) {
                if (!foundItems[uniqueKey]) {
                    var lineItem = lineItems[uniqueKey];

                    var disposalSublistRecord = record.create({
                        type: 'customrecord_asset_disposal_sublist',
                        isDynamic: true
                    });

                    disposalSublistRecord.setValue('custrecord_fam_asset', 'No asset record found. Investigate.');
                    disposalSublistRecord.setValue('custrecord_asset_location', lineItem.location);
                    disposalSublistRecord.setValue('custrecord_item', lineItem.itemId);
                    disposalSublistRecord.setValue('custrecord_quantity', lineItem.quantity);
                    disposalSublistRecord.setValue('custrecord_serial_or_lot_num', lineItem.serialOrLotNum);
                    disposalSublistRecord.setValue('custrecord_date', iaDate);
                    disposalSublistRecord.setValue('custrecord_fam_record', madRecordId);
                    disposalSublistRecord.setValue('custrecord_inventory_adjustment_link', inventoryAdjustment.id);
                    disposalSublistRecord.setValue('custrecord_inventory_adjustment_ref', inventoryAdjustment.id);

                    disposalSublistRecord.save();
                    log.error('Matching Line Item Not Found', 'Unique Key: ' + uniqueKey + ', Line Items: ' + JSON.stringify(lineItems));
                }
            };

            return madRecordId;
        } catch (e) {
            log.error('Error updating or creating MAD record', e);
            throw error.create({
                name: 'MAD_RECORD_ERROR',
                message: 'An error occurred while updating or creating the MAD record: ' + e.message,
                notifyOff: false
            });
        }
    }

    function deletePairedRecords(context) {
        var deletedRecord = context.oldRecord; // Use oldRecord because the record is being deleted
        var journalId = deletedRecord.getValue('custbody_ia_reversal_journal');

        try {
            // Delete the linked Journal Entry 
            if (journalId) {
                record.delete({
                    type: record.Type.JOURNAL_ENTRY,
                    id: journalId
                });
                log.debug('Journal Entry Deleted', 'Deleted Journal Entry with ID: ' + journalId);
            } else {
                log.debug('No Journal Entry Found', 'No linked Journal Entry to delete.');
            }

            // Delete related MAD subrecords
            deleteExistingMADRecords(deletedRecord.id);

        } catch (e) {
            log.error('Error deleting paired records', e);
            throw error.create({
                name: 'DELETE_PAIRED_RECORDS_ERROR',
                message: 'An error occurred while deleting the paired records: ' + e.message,
                notifyOff: false
            });
        }
    }

    function deleteExistingMADRecords(inventoryAdjustment) {
        try {
            log.debug('Delete MAD Record Search', 'Searchign for ' + inventoryAdjustment);

            var madSearch = search.create({
                type: 'customrecord_asset_disposal_sublist',
                filters: [
                    ['custrecord_inventory_adjustment_ref', 'is', inventoryAdjustment]
                ],
                columns: ['internalid']
            });

            var madResultSet = madSearch.run();
            var madResults = madResultSet.getRange({ start: 0, end: 1000 });

            if (madResults.length === 0) {
                // Log that no matching records were found
                log.debug('No Matching Records', 'No records found for inventory adjustment ID: ' + inventoryAdjustment);
                return; // Exit the function as there are no records to delete
            }

            madResultSet.each(function (result) {
                var madRecordId = result.getValue({ name: 'internalid' });
                record.delete({
                    type: 'customrecord_asset_disposal_sublist',
                    id: madRecordId
                });
                log.debug('MAD Record Deleted', 'Deleted MAD record with ID: ' + madRecordId);
                return true; // Continue to next result
            });

        } catch (e) {
            log.error('Error deleting MAD records', e);
            throw error.create({
                name: 'MAD_DELETION_ERROR',
                message: 'An error occurred while deleting existing MAD records: ' + e.message,
                notifyOff: false
            });
        }
    }
    return {
        afterSubmit: afterSubmit
    };
});

