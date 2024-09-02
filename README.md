# Fixed Asset Management Scripts

This repository contains three interconnected scripts designed to manage fixed asset records in a NetSuite environment. These scripts handle the creation, movement, and deletion record creation for fixed asset records, ensuring that asset management processes are automated and aligned with financial and inventory adjustments.

## Overview

1. **Asset Management User Event Script [Asset Management User Event Script (`AssetManagement_UE.js`)](https://github.com/YourUsername/YourRepoName/blob/main/path/to/AssetManagement_UE.js)
**
   - Handles the creation and updating of fixed asset records based on item receipts. It triggers upon the creation or modification of item receipts and ensures that new assets are created for applicable items, with proper accounting for landed costs, quantities, serial/lot numbers and locations.

2. **Asset Disposal Client Script [Asset Management User Event Script (`AssetDisposal_CS.js`)](https://github.com/Samuel-Dainton/NetSuite-Asset-Management/blob/main/AssetDisposal_CS.js)
**
   - Provides client-side validation to ensure that only valid fixed asset items are processed during inventory adjustments. This script validates line items, checks the asset account mappings, and prevents the saving of invalid records.

3. **Asset Disposal User Event Script (`AssetDisposal_UE.js`)[Asset Management User Event Script (`AssetManagement_UE.js`)](https://github.com/YourUsername/YourRepoName/blob/main/path/to/AssetManagement_UE.js)
**
   - Manages the creation of monthly asset deletion records, reversal journals and the deletion of paired records from inventory adjustments. It ensures that related financial records are accurately updated or removed in line with the disposal of fixed assets.

## Script Descriptions

### 1. Asset Management User Event Script (`AssetManagement_UE.js`)

- **Purpose:**  
  This script automates the creation and updating of fixed asset records in response to item receipts from purchase orders or transfer orders. It verifies the subsidiary and source transaction type before creating or updating asset records.

- **Key Functions:**
  - **Asset Creation:** Creates fixed asset records based on predefined mappings for specific asset accounts.
  - **Cost Allocation:** Distributes landed costs proportionately across all line items in an item receipt.
  - **Asset Movement:** Manages the transfer of assets between locations, updating quantities and values as necessary.
  - **Scheduled Script Trigger:** After significant updates, it triggers a scheduled script to precompute financial data for asset management.

### 2. Asset Disposal Client Script (`AssetDisposal_CS.js`)

- **Purpose:**  
  This client-side script is responsible for validating fixed asset line items in inventory adjustments. It ensures that only valid assets are included and that invalid items are flagged and prevented from being saved.

- **Key Functions:**
  - **Line Validation:** Checks each line item to ensure it corresponds to a valid fixed asset based on asset account mappings.
  - **Error Messaging:** Provides real-time feedback to users if an invalid asset item is detected, helping to prevent errors during the adjustment process.

### 3. Asset Disposal User Event Script (`AssetDisposal_UE.js`)

- **Purpose:**  
  This script manages the financial implications of disposing of fixed assets. It handles the creation of reversal journal entries to correct the financial impact of inventory adjustments which are created to function as the disposal of equipment, updates or creates Monthly Asset Disposal (MAD) records, and deletes paired records when necessary.

- **Key Functions:**
  - **Journal Entry Creation:** Automatically generates a reversal journal entry to reverse the financial impact of an inventory adjustment.
  - **MAD Record Management:** Creates or updates Monthly Asset Disposal records, which track the details of disposed assets for further processing.
  - **Record Edit and Deletion:** Edits or removes associated records, such as linked journal entries and MAD sublist records, when an inventory adjustment is edited or deleted.

## Usage

1. **Deploying the Scripts:**
   - Ensure that the scripts are correctly uploaded to the NetSuite environment against the correct records and associated with the appropriate triggers (e.g., afterSubmit for user event scripts, validateLine, and saveRecord for client scripts if not defined and handled within the script).
   
2. **Configuration:**
   - Update any asset mappings, account IDs, or other configurations within the scripts to align with the specific financial and asset management structure of your organization. The main configuration for these scripts will come from mapping the asset accoutns to the correct items records that you want to track as fixed assets, then a number of custom fields added to the fixed asset record and a completely new and customized MAD and MAD Sublist records for recording the proposed deletion of assets.

3. **Testing:**
   - Thoroughly test the scripts in a sandbox environment to ensure they perform as expected without causing disruptions to inventory adjustments or financial reporting.
