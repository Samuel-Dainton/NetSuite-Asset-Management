/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 */
define(['N/ui/message', 'N/record', 'N/search', 'N/log'], function(message, record, search, log) {

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
        '1265': { type: '111', method: '3', residual: 0.0, lifetime: 36 }
    };

    function validateLine(context) {
        return validateCurrentLine(context.currentRecord);
    }

    function saveRecord(context) {
        var currentRecord = context.currentRecord;
        var lineCount = currentRecord.getLineCount({ sublistId: 'inventory' });

        for (var i = 0; i < lineCount; i++) {
            currentRecord.selectLine({ sublistId: 'inventory', line: i });
            if (!validateCurrentLine(currentRecord)) {
                return false; // Prevent the record from being saved
            }
        }
        return true; // Allow the record to be saved
    }

    function validateCurrentLine(currentRecord) {
        var accountId = "1468"; // Internal ID for account 6323
        var iaAccount = currentRecord.getValue('account');

        // Proceed only if the IA account matches the specified account ID
        if (iaAccount === accountId) {
            var itemId = currentRecord.getCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item'
            });

            // Perform a search to get the item type
            var itemType;
            var itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [
                    ['internalid', 'is', itemId]
                ],
                columns: ['type']
            });

            itemSearch.run().each(function(result) {
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

                var myMsg = message.create({
                    title: "Invalid Item Type",
                    message: itemName + " is not a valid fixed asset item type. It is " + itemType,
                    type: message.Type.WARNING
                });
                myMsg.show();

                return false; // Prevent the user from saving the line
            }

            // Load the item record
            var itemRecord = record.load({
                type: recordType,
                id: itemId
            });

            var assetAccount = itemRecord.getValue('assetaccount'); // Assuming 'assetaccount' is the field ID for the asset account
            // Check if the asset account is valid based on the assetMapping
            if (!assetMapping.hasOwnProperty(assetAccount)) {
                var itemName = currentRecord.getCurrentSublistText({
                    sublistId: 'inventory',
                    fieldId: 'item'
                });

                // Show a warning message to the user
                var myMsg = message.create({
                    title: "Invalid Item",
                    message: itemName + " is not a fixed asset item and needs to be removed.",
                    type: message.Type.WARNING
                });
                myMsg.show();

                return false; // Prevent the user from saving the line
            }
        }

        return true; // Allow the line to be saved
    }

    return {
        validateLine: validateLine,
        saveRecord: saveRecord
    };
});