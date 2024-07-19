# Asset-Management
A script used to automate the creation and movement of serialized and lot numbered assets as they move between locations.

The script takes a number of steps to determine what record is being processed, the items involved and any existing assets at the transfer location or delivery location.

First, it rules out any deletion processes, yet to be scripted but this should report what record is being deleted and any related assets.

Then it determines if the parent transaction of the item fulfilment is a purchase order or a transfer order. If it's a purchase order, then that suggests new asset records need to be created for the first time.
If a transfer order, there are likely already asset records in the system and so a number of searches are performed using the serial/lot numbers of the item to find exisitng records.

Assets can be created, merged and moved, no assets are deleted by the script, instead, any that reach a quantity of 0 are marked as inactive.

When creating new asset records, a search is performed to see if there is a bill attached to the PO. Then an exchange rate is searched to convert the value of the items from GBP into the local currency, using the date of the exchange rate as either the bill if one exists, otherwise the IF. The price of the assets is the (last purchase price * item detail quantity) * exchange rate.

If an item fulfilment is edited instead of created, certain fields such as the landed costs are checked and used to update any existing assets. Unaccounted for fields are logged of their changes for inspection.

Created assets are marked as New and only set to depreciating once they have been moved from the warehouse.

