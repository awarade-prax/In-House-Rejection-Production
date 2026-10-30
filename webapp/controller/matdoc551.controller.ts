import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import SmartFilterBar from "sap/ui/comp/smartfilterbar/SmartFilterBar";
import SmartTable from "sap/ui/comp/smarttable/SmartTable";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Button from "sap/m/Button";
import Table from "sap/m/Table";
import ListItemBase from "sap/m/ListItemBase";
import Token from "sap/m/Token";
import MultiInput from "sap/m/MultiInput";
import Dialog from "sap/m/Dialog";
import Fragment from "sap/ui/core/Fragment";
import Event from "sap/ui/base/Event";


interface ISelected551Row {
    MaterialDocument: string;
    MaterialDocumentYear: string;
    MaterialDocumentItem: string;
    Material: string;
    MaterialDescription: string;
    ProductDescription: string;
    ScrapeDescription: string;
    QuantityInEntryUnit: string;
    EntryUnit: string;
    QuantityInBaseUnit: string;
    MaterialBaseUnit: string;
    ScrapItem: string;
    Plant: string;
    StorageLocation: string;
    PostingDate: string;
    Batch: string;
    CostCenter: string;
    NetWeightTotal: string;
    ScrapeUnit: string;
    WeightUnit: string;
}
/**
 * @namespace matdoc551.controller
 */
export default class matdoc551 extends Controller  {

    private _oPlantVHDialog: Dialog | null = null;
    private _oMaterialDocumentVHDialog: Dialog | null = null;
    private _oStorageLocationVHDialog: Dialog | null = null;

    // Prevent SmartTable from binding until all mandatory filters are validated.
    private _bAllowTableBind = false;
    private _iSearchValidationTimer: ReturnType<typeof setTimeout> | null = null;
    private _iSearchValidationRequest = 0;

    private _aAllPlants: { Plant: string }[] = [];
    private _aAllMaterialDocuments: { MaterialDocument: string; Material: string; ProductDescription: string; Plant: string }[] = [];
    private _aAllStorageLocations: { StorageLocation: string; Plant: string; MaterialDocument: string }[] = [];

    private _sMaterialDocumentVHPlant = "";
    private _sStorageLocationVHPlant = "";

    public onInit(): void {
        this.getView()?.setModel(new JSONModel({ plants: [] }), "plantVHModel");
        this.getView()?.setModel(new JSONModel({ materialDocuments: [] }), "materialDocumentVHModel");
        this.getView()?.setModel(new JSONModel({ storageLocations: [] }), "storageLocationVHModel");

        (this.getOwnerComponent() as UIComponent)
            .getRouter()
            ?.getRoute("Routeinhouserejectiontest")
            ?.attachMatched(this._onRouteMatched, this);
    }

    private _onRouteMatched(): void {
        const oShared = (this.getOwnerComponent() as UIComponent).getModel("sharedData") as JSONModel | undefined;
        const bClearFirstPageOnReturn = Boolean(oShared?.getProperty("/clearFirstPageOnReturn"));

        if (!bClearFirstPageOnReturn) {
            return;
        }

        this._clearFirstPageAfterSuccessfulPosting();
        (this.getOwnerComponent() as UIComponent).setModel(
            new JSONModel({ sourceRows: [], plant: "", clearFirstPageOnReturn: false }),
            "sharedData"
        );
    }


    private _clearFirstPageAfterSuccessfulPosting(): void {
        const oFilterBar = this._getSmartFilterBar() as any;
        const oSmartTable = this._getSmartTable();
        const oInnerTable = this._getInnerTable();

        this._clearPlantInputTokens();
        this._clearDateFilters();
        oFilterBar?.setFilterData?.({}, true);
        oFilterBar?.clear?.();

        if (oInnerTable) {
            (oInnerTable as any).unbindItems?.();
            oInnerTable.removeAllItems();
            oInnerTable.setNoDataText("No records. Apply filters and search again.");
        }

        const oSmartTableAny = oSmartTable as any;
        oSmartTableAny.setShowRowCount?.(true);
        this._setCalculateButtonEnabled(false);
        MessageToast.show("Previous posting completed. Filters and table data were cleared.");
    }

    private _clearPlantInputTokens(): void {
        const oPlantInput = this.byId("plantFilterInput") as MultiInput | undefined;
        oPlantInput?.removeAllTokens();
        oPlantInput?.setValue?.("");
    }

    private _clearDateFilters(): void {
        (this.byId("fromDateFilter") as any)?.setDateValue?.(null);
        (this.byId("toDateFilter") as any)?.setDateValue?.(null);
    }

    private _getDynamicDateValue(sControlId: string): Date | null {
        const oControl = this.byId(sControlId) as any;

        if (!oControl) {
            return null;
        }

        const oDate = oControl.getDateValue?.();

        if (oDate instanceof Date && !isNaN(oDate.getTime())) {
            return new Date(
                oDate.getFullYear(),
                oDate.getMonth(),
                oDate.getDate(),
                12,
                0,
                0,
                0
            );
        }

        return null;
    }

    // Convert the LOCAL calendar date to an OData DateTime boundary at UTC
    // midnight. ODataUtils serializes Edm.DateTime using the UTC timestamp,
    // so this produces exactly datetime'2026-06-03T00:00:00' for 03-Jun-2026.
    private _toODataDate(oDate: Date): Date {
        return new Date(
            Date.UTC(
                oDate.getFullYear(),
                oDate.getMonth(),
                oDate.getDate(),
                0, 0, 0, 0
            )
        );
    }

    // ---------------------------------------------------------------------
    // SmartFilterBar
    // ---------------------------------------------------------------------

    public onFilterBarInitialised(): void {
        this._getSmartFilterBar().setFilterBarExpanded(true);
        this._markPlantMandatory();
        this._applyDateFilterOptions();
        this._setCalculateButtonEnabled(false);
    }

    // Best-effort: some UI5 versions support narrowing DynamicDateRange to just
    // DATE/TODAY/YESTERDAY/TOMORROW via setOptions(); older versions don't expose
    // this API at all, in which case we just keep the full default option list.
    private _applyDateFilterOptions(): void {
        const aDesiredOptions = ["DATE", "TODAY", "YESTERDAY", "TOMORROW"];
        ["fromDateFilter", "toDateFilter"].forEach((sId) => {
            const oControl = this.byId(sId) as any;
            if (typeof oControl?.setOptions === "function") {
                try {
                    oControl.setOptions(aDesiredOptions);
                } catch (oError) {
                    // eslint-disable-next-line no-console
                    console.warn(`Could not narrow options on ${sId}, keeping defaults.`, oError);
                }
            }
        });
    }

    public onSearch(): void {
        // Always block the SmartTable first. SmartFilterBar may trigger a
        // SmartTable rebind immediately after this handler returns.
        this._bAllowTableBind = false;

        // Ignore any older delayed validation callback.
        const iRequest = ++this._iSearchValidationRequest;

        if (this._iSearchValidationTimer !== null) {
            clearTimeout(this._iSearchValidationTimer);
            this._iSearchValidationTimer = null;
        }

        if (!this._isPlantSelected()) {
            MessageBox.error("Plant is mandatory. Please select a Plant before searching.", {
                title: "Missing Required Filter"
            });
            return;
        }

        // DynamicDateRange can commit its selected value one UI5 event-loop
        // tick after the Go/Search event. Validate after that commit.
        this._iSearchValidationTimer = setTimeout(() => {
            this._iSearchValidationTimer = null;

            if (iRequest !== this._iSearchValidationRequest) {
                return;
            }

            this._runSearchValidationAndRebind();
        }, 0);
    }

    private _runSearchValidationAndRebind(): void {
        const dFromDate = this._getDynamicDateValue("fromDateFilter");
        const dToDate = this._getDynamicDateValue("toDateFilter");

        if (!dFromDate || !dToDate) {
            this._bAllowTableBind = false;
            MessageBox.error("From Date and To Date are mandatory. Please select both before searching.", {
                title: "Missing Required Filter"
            });
            return;
        }

        if (dFromDate.getTime() > dToDate.getTime()) {
            this._bAllowTableBind = false;
            MessageBox.error("From Date cannot be later than To Date.", {
                title: "Invalid Date Range"
            });
            return;
        }

        // Validation passed. Allow exactly the rebind that we trigger below.
        this._bAllowTableBind = true;
        this._setCalculateButtonEnabled(false);
        this._getSmartTable().rebindTable(true);
    }

    public onFilterChange(_oEvent: Event): void {
        this._setCalculateButtonEnabled(false);
    }

    public onDateFilterChange(_oEvent?: Event): void {
        this._setCalculateButtonEnabled(false);
    }

    // ---------------------------------------------------------------------
    // Custom Plant Value Help
    // ---------------------------------------------------------------------

    public async onOpenPlantValueHelp(): Promise<void> {
        if (!this._oPlantVHDialog) {
            this._oPlantVHDialog = await Fragment.load({
                id: this.getView()?.getId(),
                name: "matdoc551.view.PlantValueHelp",
                controller: this
            }) as Dialog;
            this.getView()?.addDependent(this._oPlantVHDialog);
        }

        if (this._aAllPlants.length === 0) {
            await this._loadPlantValues();
        }

        this._filterPlantList("");
        this._oPlantVHDialog.open();
    }

    public onPlantVHSearch(oEvent: Event): void {
        const sQuery = ((oEvent as any).getParameter("value") as string)
            ?? ((oEvent as any).getParameter("newValue") as string)
            ?? "";

        this._filterPlantList(sQuery);
    }

    public onPlantVHSelect(oEvent: Event): void {
        const oItem = (oEvent as any).getParameter("listItem") as ListItemBase;
        const oCtx = oItem?.getBindingContext("plantVHModel");
        const sPlant = String(oCtx?.getProperty("Plant") ?? "").trim();

        if (sPlant) {
            const sOldPlant = this._getSelectedPlant();
            this._setSinglePlantToken(sPlant);

            if (sOldPlant !== sPlant) {
                this._clearPlantDependentFilters();
            }
        }

        this._closePlantValueHelp();
        this._setCalculateButtonEnabled(false);
    }

    public onPlantVHClose(): void {
        this._closePlantValueHelp();
    }

    public onPlantTokenUpdate(oEvent?: Event): void {
        const sType = String((oEvent as any)?.getParameter?.("type") ?? "");

        if (sType === "removed" || sType === "removedAll" || sType === "tokensChanged") {
            const aRemovedTokens = ((oEvent as any)?.getParameter?.("removedTokens") ?? []) as Token[];
            if (aRemovedTokens.length > 0 || sType === "removed" || sType === "removedAll") {
                this._clearPlantDependentFilters();
            }
        }

        setTimeout(() => {
            if (!this._getSelectedPlant()) {
                this._syncPlantToSmartFilterBar("");
                this._clearPlantDependentFilters();
            }
        }, 0);

        this._setCalculateButtonEnabled(false);
    }

    private _closePlantValueHelp(): void {
        this._oPlantVHDialog?.close();
    }

    private _loadPlantValues(): Promise<void> {
        return new Promise((resolve) => {
            const oModel = this.getView()?.getModel() as any;

            oModel.read("/YY1_MAT_DOC_551", {
                urlParameters: {
                    $select: "Plant",
                    $top: "5000"
                },
                success: (oData: { results: { Plant: string }[] }) => {
                    const aPlants = Array.from(
                        new Set((oData.results ?? [])
                            .map((oRow) => String(oRow.Plant ?? "").trim())
                            .filter((sPlant) => sPlant.length > 0))
                    )
                        .sort()
                        .map((sPlant) => ({ Plant: sPlant }));

                    this._aAllPlants = aPlants;
                    resolve();
                },
                error: () => {
                    this._aAllPlants = [];
                    MessageToast.show("Plant value help data could not be loaded.");
                    resolve();
                }
            });
        });
    }

    private _filterPlantList(sQuery: string): void {
        const sNeedle = sQuery.trim().toLowerCase();
        const aPlants = sNeedle
            ? this._aAllPlants.filter((oPlant) => oPlant.Plant.toLowerCase().includes(sNeedle))
            : [...this._aAllPlants];

        (this.getView()?.getModel("plantVHModel") as JSONModel).setProperty("/plants", aPlants);
    }

    private _setSinglePlantToken(sPlant: string): void {
        const oPlantInput = this.byId("plantFilterInput") as MultiInput;
        if (!oPlantInput) {
            return;
        }

        oPlantInput.removeAllTokens();
        oPlantInput.setValue("");
        oPlantInput.addToken(new Token({ key: sPlant, text: sPlant }));

        // Keep SmartFilterBar internal filter data in sync.
        // Standard annotation-based value helps use this Plant value as
        // ValueListParameterIn for MaterialDocument and StorageLocation.
        this._syncPlantToSmartFilterBar(sPlant);
    }

    private _getSelectedPlant(): string {
        const oPlantInput = this.byId("plantFilterInput") as MultiInput;
        const aTokens = oPlantInput?.getTokens?.() ?? [];

        if (aTokens.length === 0) {
            return "";
        }

        return String(aTokens[0].getKey() || aTokens[0].getText() || "").trim();
    }

    // ---------------------------------------------------------------------
    // Custom Material Document Value Help - filtered by selected Plant
    // ---------------------------------------------------------------------

    public async onOpenMaterialDocumentValueHelp(): Promise<void> {
        const sPlant = this._getSelectedPlant();

        if (!sPlant) {
            MessageBox.warning("Please select Plant first.");
            return;
        }

        if (!this._oMaterialDocumentVHDialog) {
            this._oMaterialDocumentVHDialog = await Fragment.load({
                id: this.getView()?.getId(),
                name: "inhouserejectiontest.view.MaterialDocumentValueHelp",
                controller: this
            }) as Dialog;
            this.getView()?.addDependent(this._oMaterialDocumentVHDialog);
        }

        if (this._sMaterialDocumentVHPlant !== sPlant || this._aAllMaterialDocuments.length === 0) {
            await this._loadMaterialDocumentValues(sPlant);
        }

        this._filterMaterialDocumentList("");
        this._oMaterialDocumentVHDialog.open();
    }

    public onMaterialDocumentVHSearch(oEvent: Event): void {
        const sQuery = ((oEvent as any).getParameter("value") as string)
            ?? ((oEvent as any).getParameter("newValue") as string)
            ?? "";

        this._filterMaterialDocumentList(sQuery);
    }

    public onMaterialDocumentVHSelect(oEvent: Event): void {
        const oItem = (oEvent as any).getParameter("listItem") as ListItemBase;
        const oCtx = oItem?.getBindingContext("materialDocumentVHModel");
        const sMaterialDocument = String(oCtx?.getProperty("MaterialDocument") ?? "").trim();

        if (sMaterialDocument) {
            this._setSingleMaterialDocumentToken(sMaterialDocument);
        }

        this._oMaterialDocumentVHDialog?.close();
        this._setCalculateButtonEnabled(false);
    }

    public onMaterialDocumentVHClose(): void {
        this._oMaterialDocumentVHDialog?.close();
    }

    public onMaterialDocumentTokenUpdate(): void {
        this._setCalculateButtonEnabled(false);
    }

    private _loadMaterialDocumentValues(sPlant: string): Promise<void> {
        return new Promise((resolve) => {
            const oModel = this.getView()?.getModel() as any;

            oModel.read("/YY1_MAT_DOC_551", {
                filters: [new Filter("Plant", FilterOperator.EQ, sPlant)],
                urlParameters: {
                    $select: "MaterialDocument,Material,ProductDescription,Plant",
                    $top: "5000"
                },
                success: (oData: { results: { MaterialDocument: string; Material: string; ProductDescription: string; Plant: string }[] }) => {
                    const oSeen = new Set<string>();
                    const aMaterialDocuments = (oData.results ?? [])
                        .map((oRow) => ({
                            MaterialDocument: String(oRow.MaterialDocument ?? "").trim(),
                            Material: String(oRow.Material ?? "").trim(),
                            ProductDescription: String(oRow.ProductDescription ?? "").trim(),
                            Plant: String(oRow.Plant ?? "").trim()
                        }))
                        .filter((oRow) => {
                            if (!oRow.MaterialDocument || oSeen.has(oRow.MaterialDocument)) {
                                return false;
                            }
                            oSeen.add(oRow.MaterialDocument);
                            return true;
                        })
                        .sort((a, b) => a.MaterialDocument.localeCompare(b.MaterialDocument));

                    this._aAllMaterialDocuments = aMaterialDocuments;
                    this._sMaterialDocumentVHPlant = sPlant;
                    resolve();
                },
                error: () => {
                    this._aAllMaterialDocuments = [];
                    this._sMaterialDocumentVHPlant = "";
                    MessageToast.show("Material Document value help data could not be loaded.");
                    resolve();
                }
            });
        });
    }

    private _filterMaterialDocumentList(sQuery: string): void {
        const sNeedle = sQuery.trim().toLowerCase();
        const aRows = sNeedle
            ? this._aAllMaterialDocuments.filter((oRow) =>
                oRow.MaterialDocument.toLowerCase().includes(sNeedle)
                || oRow.Material.toLowerCase().includes(sNeedle)
                || oRow.ProductDescription.toLowerCase().includes(sNeedle))
            : [...this._aAllMaterialDocuments];

        (this.getView()?.getModel("materialDocumentVHModel") as JSONModel).setProperty("/materialDocuments", aRows);
    }

    private _setSingleMaterialDocumentToken(sMaterialDocument: string): void {
        const oInput = this.byId("materialDocumentFilterInput") as MultiInput;
        if (!oInput) {
            return;
        }

        oInput.removeAllTokens();
        oInput.setValue("");
        oInput.addToken(new Token({ key: sMaterialDocument, text: sMaterialDocument }));
    }

    private _getSelectedMaterialDocument(): string {
        const oInput = this.byId("materialDocumentFilterInput") as MultiInput;
        const aTokens = oInput?.getTokens?.() ?? [];

        if (aTokens.length === 0) {
            return "";
        }

        return String(aTokens[0].getKey() || aTokens[0].getText() || "").trim();
    }

    // ---------------------------------------------------------------------
    // Custom Storage Location Value Help - filtered by selected Plant
    // ---------------------------------------------------------------------

    public async onOpenStorageLocationValueHelp(): Promise<void> {
        const sPlant = this._getSelectedPlant();

        if (!sPlant) {
            MessageBox.warning("Please select Plant first.");
            return;
        }

        if (!this._oStorageLocationVHDialog) {
            this._oStorageLocationVHDialog = await Fragment.load({
                id: this.getView()?.getId(),
                name: "inhouserejectiontest.view.StorageLocationValueHelp",
                controller: this
            }) as Dialog;
            this.getView()?.addDependent(this._oStorageLocationVHDialog);
        }

        if (this._sStorageLocationVHPlant !== sPlant || this._aAllStorageLocations.length === 0) {
            await this._loadStorageLocationValues(sPlant);
        }

        this._filterStorageLocationList("");
        this._oStorageLocationVHDialog.open();
    }

    public onStorageLocationVHSearch(oEvent: Event): void {
        const sQuery = ((oEvent as any).getParameter("value") as string)
            ?? ((oEvent as any).getParameter("newValue") as string)
            ?? "";

        this._filterStorageLocationList(sQuery);
    }

    public onStorageLocationVHSelect(oEvent: Event): void {
        const oItem = (oEvent as any).getParameter("listItem") as ListItemBase;
        const oCtx = oItem?.getBindingContext("storageLocationVHModel");
        const sStorageLocation = String(oCtx?.getProperty("StorageLocation") ?? "").trim();

        if (sStorageLocation) {
            this._setSingleStorageLocationToken(sStorageLocation);
        }

        this._oStorageLocationVHDialog?.close();
        this._setCalculateButtonEnabled(false);
    }

    public onStorageLocationVHClose(): void {
        this._oStorageLocationVHDialog?.close();
    }

    public onStorageLocationTokenUpdate(): void {
        this._setCalculateButtonEnabled(false);
    }

    private _loadStorageLocationValues(sPlant: string): Promise<void> {
        return new Promise((resolve) => {
            const oModel = this.getView()?.getModel() as any;

            oModel.read("/YY1_MAT_DOC_551", {
                filters: [new Filter("Plant", FilterOperator.EQ, sPlant)],
                urlParameters: {
                    $select: "StorageLocation,Plant,MaterialDocument",
                    $top: "5000"
                },
                success: (oData: { results: { StorageLocation: string; Plant: string; MaterialDocument: string }[] }) => {
                    const oSeen = new Set<string>();
                    const aStorageLocations = (oData.results ?? [])
                        .map((oRow) => ({
                            StorageLocation: String(oRow.StorageLocation ?? "").trim(),
                            Plant: String(oRow.Plant ?? "").trim(),
                            MaterialDocument: String(oRow.MaterialDocument ?? "").trim()
                        }))
                        .filter((oRow) => {
                            if (!oRow.StorageLocation || oSeen.has(oRow.StorageLocation)) {
                                return false;
                            }
                            oSeen.add(oRow.StorageLocation);
                            return true;
                        })
                        .sort((a, b) => a.StorageLocation.localeCompare(b.StorageLocation));

                    this._aAllStorageLocations = aStorageLocations;
                    this._sStorageLocationVHPlant = sPlant;
                    resolve();
                },
                error: () => {
                    this._aAllStorageLocations = [];
                    this._sStorageLocationVHPlant = "";
                    MessageToast.show("Storage Location value help data could not be loaded.");
                    resolve();
                }
            });
        });
    }

    private _filterStorageLocationList(sQuery: string): void {
        const sNeedle = sQuery.trim().toLowerCase();
        const aRows = sNeedle
            ? this._aAllStorageLocations.filter((oRow) =>
                oRow.StorageLocation.toLowerCase().includes(sNeedle)
                || oRow.MaterialDocument.toLowerCase().includes(sNeedle))
            : [...this._aAllStorageLocations];

        (this.getView()?.getModel("storageLocationVHModel") as JSONModel).setProperty("/storageLocations", aRows);
    }

    private _setSingleStorageLocationToken(sStorageLocation: string): void {
        const oInput = this.byId("storageLocationFilterInput") as MultiInput;
        if (!oInput) {
            return;
        }

        oInput.removeAllTokens();
        oInput.setValue("");
        oInput.addToken(new Token({ key: sStorageLocation, text: sStorageLocation }));
    }

    private _getSelectedStorageLocation(): string {
        return this._getSelectedSmartFilterValues("StorageLocation")[0] ?? "";
    }

    private _getSelectedSmartFilterValues(sKey: string): string[] {
        const oFilterBar = this._getSmartFilterBar() as any;
        const oControl = oFilterBar?.getControlByKey?.(sKey) as any;
        const aValues: string[] = [];

        const aTokens = oControl?.getTokens?.() ?? [];
        aTokens.forEach((oToken: any) => {
            const sValue = String(oToken.getKey?.() || oToken.getText?.() || "").trim();
            if (sValue && !aValues.includes(sValue)) {
                aValues.push(sValue);
            }
        });

        const sValue = String(oControl?.getValue?.() ?? "").trim();
        if (sValue && !aValues.includes(sValue)) {
            aValues.push(sValue);
        }

        return aValues;
    }

    private _createMultiEQFilter(sPath: string, aValues: string[]): Filter | null {
        const aUniqueValues = aValues
            .map((sValue) => String(sValue ?? "").trim())
            .filter((sValue, iIndex, aAll) => sValue && aAll.indexOf(sValue) === iIndex);

        if (aUniqueValues.length === 0) {
            return null;
        }

        if (aUniqueValues.length === 1) {
            return new Filter(sPath, FilterOperator.EQ, aUniqueValues[0]);
        }

        return new Filter({
            filters: aUniqueValues.map((sValue) => new Filter(sPath, FilterOperator.EQ, sValue)),
            and: false
        });
    }

    private _clearPlantDependentFilters(): void {
        // Plant change/removal should clear only Plant-dependent filters.
        // PostingDate must remain as selected/defaulted.
        this._clearStandardSmartFilterField("MaterialDocument");
        this._clearStandardSmartFilterField("StorageLocation");

        this._aAllMaterialDocuments = [];
        this._aAllStorageLocations = [];
        this._sMaterialDocumentVHPlant = "";
        this._sStorageLocationVHPlant = "";

        (this.getView()?.getModel("materialDocumentVHModel") as JSONModel)?.setProperty("/materialDocuments", []);
        (this.getView()?.getModel("storageLocationVHModel") as JSONModel)?.setProperty("/storageLocations", []);
    }

    private _clearStandardSmartFilterField(sKey: string): void {
        const oFilterBar = this._getSmartFilterBar() as any;
        const oControl = oFilterBar.getControlByKey?.(sKey) as any;

        oControl?.removeAllTokens?.();
        oControl?.setTokens?.([]);
        oControl?.setValue?.("");
        oControl?.setSelectedKey?.("");

        const oFilterData = oFilterBar.getFilterData?.(true) ?? {};
        delete oFilterData[sKey];
        oFilterBar.setFilterData?.(oFilterData, true);
    }

    private _syncPlantToSmartFilterBar(sPlant: string): void {
        const oFilterBar = this._getSmartFilterBar() as any;
        const oFilterData = oFilterBar.getFilterData?.(true) ?? {};

        if (sPlant) {
            oFilterData.Plant = sPlant;
        } else {
            delete oFilterData.Plant;
        }

        oFilterBar.setFilterData?.(oFilterData, true);
    }

    private _mergeSelectFields(sExistingSelect: string, aRequiredFields: string[]): string {
        const aExistingFields = sExistingSelect
            .split(",")
            .map((sField) => sField.trim())
            .filter(Boolean);

        const oFields = new Set<string>(aExistingFields);
        aRequiredFields.forEach((sField) => oFields.add(sField));

        return Array.from(oFields).join(",");
    }

    // ---------------------------------------------------------------------
    // SmartTable
    // ---------------------------------------------------------------------

    public onSmartTableInitialised(): void {
        const oInnerTable = this._getInnerTable();
        if (!oInnerTable) {
            return;
        }

        // Checkboxes enabled - user selects specific rows and only those are
        // sent to scrap calculation (see onNavigateToCalculateScrap).
        (oInnerTable as any).setMode("MultiSelect");

        oInnerTable.attachUpdateFinished(this._onTableUpdateFinished.bind(this));
        (oInnerTable as any).attachSelectionChange?.(this._onTableSelectionChange.bind(this));
    }

    public onBeforeRebindTable(oEvent: Event): void {
        const oBindingParams = (oEvent as any).mParameters.bindingParams as {
            filters: Filter[];
            sorter: unknown[];
            parameters: Record<string, unknown>;
        };

        // Final safety guard: no OData request is allowed unless onSearch()
        // has validated Plant, From Date and To Date.
        if (!this._bAllowTableBind) {
            (oBindingParams as any).preventTableBind = true;
            return;
        }

        // Consume the permission so another SmartTable rebind cannot happen
        // without going through the mandatory-filter validation again.
        this._bAllowTableBind = false;

        oBindingParams.parameters = oBindingParams.parameters ?? {};
        oBindingParams.parameters["$count"] = true;

        // These fields are required later for CBO 551 child posting even if they are
        // hidden/ignored in the SmartTable personalization. Force them into the OData
        // response so _get551RowFromTableRow can read them from the row context.
        const aMandatorySelectFields = [
            "MaterialDocument",
            "MaterialDocumentYear",
            "MaterialDocumentItem",
            "Material",
            "ProductDescription",
            "QuantityInBaseUnit",
            "MaterialBaseUnit",
            "YY1_ScrapItem_MMI",
            "ScrapeUnit",
            "ScrapeDescription",
            "NetWeight",
            "WeightUnit",
            "NetWeightTotal",
            "StorageLocation",
            "Plant",
            "PostingDate",
            "Batch",
            "CostCenter"
        ];
        oBindingParams.parameters["select"] = this._mergeSelectFields(
            String(oBindingParams.parameters["select"] ?? oBindingParams.parameters["$select"] ?? ""),
            aMandatorySelectFields
        );

        // Plant is custom handled.
        // MaterialDocument uses standard value help, but we rebuild its table filter
        // here to avoid wrong/empty SmartFilterBar generated token filters.
        // FromDate/ToDate are virtual (non-metadata) fields - they never produce their
        // own generated filters, but PostingDate itself is stripped too so our manual
        // GE/LE range below is the only PostingDate filter applied.
        oBindingParams.filters = this._removeFiltersForPath(oBindingParams.filters ?? [], "Plant");
        oBindingParams.filters = this._removeFiltersForPath(oBindingParams.filters ?? [], "MaterialDocument");
        oBindingParams.filters = this._removeFiltersForPath(oBindingParams.filters ?? [], "PostingDate");

        const sPlant = this._getSelectedPlant();
        if (sPlant) {
            oBindingParams.filters.push(new Filter("Plant", FilterOperator.EQ, sPlant));
        }

        const oMaterialDocumentFilter = this._createMultiEQFilter(
            "MaterialDocument",
            this._getSelectedSmartFilterValues("MaterialDocument")
        );
        if (oMaterialDocumentFilter) {
            oBindingParams.filters.push(oMaterialDocumentFilter);
        }

        const dFromDate = this._getDynamicDateValue("fromDateFilter");
        const dToDate = this._getDynamicDateValue("toDateFilter");

        // Apply an inclusive calendar-date range.
        // The upper boundary is exclusive and moved to the next day so that
        // records posted at any time on the selected To Date are included.
        // Example: To Date = 02-Jun-2026 -> PostingDate < 03-Jun-2026 00:00:00.
        if (dFromDate && dToDate) {
            const oFromDate = this._toODataDate(dFromDate);
            const oToDateExclusive = this._toODataDate(dToDate);
            oToDateExclusive.setUTCDate(oToDateExclusive.getUTCDate() + 1);

            oBindingParams.filters.push(
                new Filter({
                    filters: [
                        new Filter(
                            "PostingDate",
                            FilterOperator.GE,
                            oFromDate
                        ),
                        new Filter(
                            "PostingDate",
                            FilterOperator.LT,
                            oToDateExclusive
                        )
                    ],
                    and: true
                })
            );
        }
    }

    private _onTableUpdateFinished(): void {
        const oInnerTable = this._getInnerTable();
        this._setCalculateButtonEnabled(Boolean(oInnerTable && (oInnerTable as any).getSelectedItems?.().length > 0));
    }

    private _onTableSelectionChange(): void {
        const oInnerTable = this._getInnerTable();
        this._setCalculateButtonEnabled(Boolean(oInnerTable && (oInnerTable as any).getSelectedItems?.().length > 0));
    }

    // ---------------------------------------------------------------------
    // Navigate to Scrap Calculation page
    // ---------------------------------------------------------------------

    public onNavigateToCalculateScrap(): void {
        const oInnerTable = this._getInnerTable();
        if (!oInnerTable) {
            MessageBox.error("Table is not available yet. Please try again.");
            return;
        }

        const aRows = (oInnerTable as any).getSelectedItems?.() ?? [];
        if (aRows.length === 0) {
            MessageBox.warning("Please select at least one row before calculating scrap.");
            return;
        }

        const aRowsFor552 = this._collectRowsFor552(oInnerTable, aRows);
        if (aRowsFor552.length === 0) {
            MessageBox.warning("No Scrap Item values are available in the selected records.");
            return;
        }

        (this.getOwnerComponent() as UIComponent).setModel(
            new JSONModel({
                sourceRows: aRowsFor552,
                plant: this._getSelectedPlant(),
                clearFirstPageOnReturn: false
            }),
            "sharedData"
        );

        (this.getOwnerComponent() as UIComponent)
            .getRouter()
            ?.navTo("RouteCalculateScrap");
    }

    private _collectRowsFor552(oTable: Table, aRows: ListItemBase[]): ISelected551Row[] {
        return aRows
            .map((oRow) => this._get551RowFromTableRow(oTable, oRow))
            .filter((oRow) => Boolean(oRow.ScrapItem));
    }

    private _get551RowFromTableRow(oTable: Table, oRow: ListItemBase): ISelected551Row {
        const oCtx = oRow.getBindingContext();
        const oObj = (oCtx?.getObject() ?? {}) as Record<string, unknown>;

        return {
            MaterialDocument: this._readField(oObj, ["MaterialDocument"]),
            MaterialDocumentYear: this._readField(oObj, ["MaterialDocumentYear"]),
            MaterialDocumentItem: this._readField(
                oObj,
                ["MaterialDocumentItem", "I_MaterialDocumentItem_2.MaterialDocumentItem"],
                oTable,
                oRow,
                "Material Document Item"
            ),
            Material: this._readField(oObj, ["Material"], oTable, oRow, "Material"),
            MaterialDescription: this._readField(
                oObj,
                ["MaterialDescription", "ProductDescription"],
                oTable,
                oRow,
                "Material Description"
            ),
            ProductDescription: this._readField(oObj, ["ProductDescription"], oTable, oRow, "Product Description"),
            ScrapeDescription: this._readField(
                oObj,
                ["ScrapeDescription", "ScrapDescription", "YY1_ScrapeDescription", "YY1_SCRAPEDESCRIPTION"],
                oTable,
                oRow,
                "Scrape Description"
            ),
            QuantityInEntryUnit: this._readField(oObj, ["QuantityInEntryUnit"], oTable, oRow, "Quantity in Entry Unit"),
            EntryUnit: this._readField(oObj, ["EntryUnit"], oTable, oRow, "Entry Unit"),
            QuantityInBaseUnit: this._readField(oObj, ["QuantityInBaseUnit"], oTable, oRow, "Quantity in Base Unit"),
            MaterialBaseUnit: this._readField(oObj, ["MaterialBaseUnit"], oTable, oRow, "Material Base Unit"),
            ScrapItem: this._readField(
                oObj,
                ["YY1_ScrapItem_MMI", "ScrapItem", "ScrapeItem", "YY1_ScrapItem", "YY1_SCRAPITEM"],
                oTable,
                oRow,
                "Scrap Item"
            ),
            Plant: this._readField(oObj, ["Plant"], oTable, oRow, "Plant") || this._getSelectedPlant(),
            StorageLocation: this._readField(
                oObj,
                ["StorageLocation", "I_MaterialDocumentItem_2.StorageLocation"],
                oTable,
                oRow,
                "Storage Location"
            ),
            PostingDate: this._readField(oObj, ["PostingDate"], oTable, oRow, "Posting Date"),
            Batch: this._readField(oObj, ["Batch"], oTable, oRow, "Batch"),
            CostCenter: this._readField(oObj, ["CostCenter", "CostCentre", "YY1_CostCenter", "YY1_COSTCENTER"], oTable, oRow, "Cost Center"),
            NetWeightTotal: this._readField(
                oObj,
                ["NetWeightTotal", "ScrapeNetWeight", "ActualScrapeNetWeight", "NetWeight"],
                oTable,
                oRow,
                "Net Weight Total"
            ),
            ScrapeUnit: this._readField(
                oObj,
                ["ScrapeUnit"],
                oTable,
                oRow,
                "Scrape Unit"
            ),
            WeightUnit: this._readField(
                oObj,
                ["WeightUnit"],
                oTable,
                oRow,
                "Weight Unit"
            )
        };
    }

    private _readField(
        oObj: Record<string, unknown>,
        aFieldNames: string[],
        oTable?: Table,
        oRow?: ListItemBase,
        sColumnHeader?: string
    ): string {
        for (const sFieldName of aFieldNames) {
            const sValue = this._normalizeTableValue(this._getObjectValue(oObj, sFieldName));
            if (sValue) {
                return sValue;
            }
        }

        if (oTable && oRow && sColumnHeader) {
            const iIndex = this._findColumnIndexByHeader(oTable, sColumnHeader);
            const aCells = (oRow as any).getCells?.() ?? [];
            if (iIndex > -1 && aCells[iIndex]) {
                return this._readTextFromCell(aCells[iIndex]);
            }
        }

        return "";
    }

    private _getObjectValue(oObj: Record<string, unknown>, sFieldName: string): unknown {
        if (Object.prototype.hasOwnProperty.call(oObj, sFieldName)) {
            return oObj[sFieldName];
        }

        if (!sFieldName.includes(".")) {
            return undefined;
        }

        return sFieldName.split(".").reduce<unknown>((vCurrent, sPart) => {
            if (vCurrent && typeof vCurrent === "object") {
                return (vCurrent as Record<string, unknown>)[sPart];
            }
            return undefined;
        }, oObj);
    }

    private _findColumnIndexByHeader(oTable: Table, sExpectedHeader: string): number {
        const sExpected = sExpectedHeader.replace(/\s/g, "").toLowerCase();
        const aColumns = oTable.getColumns();

        for (let i = 0; i < aColumns.length; i++) {
            const oColumn = aColumns[i] as any;
            const sHeaderText = String(oColumn.getHeader?.()?.getText?.() ?? "")
                .replace(/\s/g, "")
                .toLowerCase();
            const aCustomData = oColumn.getCustomData?.() ?? [];
            const bMatchesCustomData = aCustomData.some((oCustomData: any) => {
                const vValue = oCustomData.getValue?.();
                const sValue = typeof vValue === "string" ? vValue : JSON.stringify(vValue ?? {});
                return aFieldLike(sValue).includes(sExpected);
            });

            if (sHeaderText === sExpected || bMatchesCustomData) {
                return i;
            }
        }

        function aFieldLike(sValue: string): string {
            return sValue.replace(/\s/g, "").toLowerCase();
        }

        return -1;
    }

    private _readTextFromCell(oCell: any): string {
        const vValue =
            oCell.getText?.() ??
            oCell.getValue?.() ??
            oCell.getTitle?.() ??
            oCell.getNumber?.() ??
            "";

        return this._normalizeTableValue(vValue);
    }

    private _normalizeTableValue(vValue: unknown): string {
        if (vValue === null || vValue === undefined) {
            return "";
        }

        const sValue = String(vValue).trim();
        return sValue.length > 0 ? sValue : "";
    }

    // ---------------------------------------------------------------------
    // Toolbar actions
    // ---------------------------------------------------------------------

    public onExport(): void {
        const oSmartTable = this._getSmartTable();
        const oTable = oSmartTable.getTable() as Table;

        if (oTable) {
            (oSmartTable as unknown as { _triggerExcelExport: () => void })._triggerExcelExport();
        } else {
            MessageToast.show("Export is not available yet. Please wait for the table to load.");
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private _setCalculateButtonEnabled(bEnabled: boolean): void {
        const oBtn = this.byId("btnCalculateScrap") as Button;
        if (oBtn) {
            oBtn.setEnabled(bEnabled);
        }
    }

    private _getInnerTable(): Table | null {
        const oInnerTable = this._getSmartTable().getTable();
        return oInnerTable ? (oInnerTable as Table) : null;
    }

    private _markPlantMandatory(): void {
        const oFilterBar = this._getSmartFilterBar();
        const aItems: any[] = (oFilterBar as any).getAllFilterItems?.(true) ?? [];
        const oPlantItem = aItems.find((oItem: any) => (oItem.getName?.() as string) === "Plant");

        if (oPlantItem) {
            oPlantItem.setMandatory?.(true);
        }
    }

    private _isPlantSelected(): boolean {
        return this._getSelectedPlant().length > 0;
    }

    private _removeFiltersForPath(aFilters: Filter[], sPath: string): Filter[] {
        const aCleaned: Filter[] = [];

        aFilters.forEach((oFilter) => {
            const oCleaned = this._removeFilterForPath(oFilter, sPath);
            if (oCleaned) {
                aCleaned.push(oCleaned);
            }
        });

        return aCleaned;
    }

    private _removeFilterForPath(oFilter: Filter, sPath: string): Filter | null {
        const oAnyFilter = oFilter as any;

        if (oAnyFilter.sPath === sPath || oAnyFilter.path === sPath) {
            return null;
        }

        const aSubFilters = oAnyFilter.aFilters as Filter[] | undefined;
        if (!Array.isArray(aSubFilters)) {
            return oFilter;
        }

        const aRemaining = aSubFilters
            .map((oSubFilter) => this._removeFilterForPath(oSubFilter, sPath))
            .filter((oSubFilter): oSubFilter is Filter => !!oSubFilter);

        if (aRemaining.length === 0) {
            return null;
        }

        if (aRemaining.length === 1) {
            return aRemaining[0];
        }

        return new Filter({
            filters: aRemaining,
            and: oAnyFilter.bAnd !== false
        });
    }

    private _getSmartFilterBar(): SmartFilterBar {
        return this.byId("smartFilterBar") as SmartFilterBar;
    }

    private _getSmartTable(): SmartTable {
        return this.byId("smartTable") as SmartTable;
    }
}