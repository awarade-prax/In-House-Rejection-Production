import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import History from "sap/ui/core/routing/History";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Event from "sap/ui/base/Event";
import Input from "sap/m/Input";

interface IPageModel {
    busy: boolean;
    message: string;
    messageType: string;
    messageVisible: boolean;
    migoOverviewVisible: boolean;
    migoOverview: IMIGOOverview;
    cboStatusText: string;
    cboStatusState: string;
    cboStatusIcon: string;
    bottomMessage: string;
    bottomState: string;
    bottomIcon: string;
    bottomVisible: boolean;
    post552Enabled: boolean;
}

interface ISource551Row {
    MaterialDocument?: string;
    MaterialDocumentYear?: string;
    MaterialDocumentItem?: string;
    Material?: string;
    MaterialDescription?: string;
    ProductDescription?: string;
    ScrapeDescription?: string;
    QuantityInEntryUnit?: string;
    EntryUnit?: string;
    QuantityInBaseUnit?: string;
    MaterialBaseUnit?: string;
    ScrapItem: string;
    Plant: string;
    StorageLocation?: string;
    PostingDate?: string | Date;
    Batch?: string;
    CostCenter?: string;
    NetWeightTotal: string;
    ScrapeUnit: string;
    WeightUnit?: string;
}

interface IMIGOOverview {
    MaterialDocument: string;
    FiscalYear: string;
    DocumentDate: string;
    PostingDate: string;
    GoodsMovementCode: string;
    items: IMIGOOverviewItem[];
}

interface IMIGOOverviewItem {
    MaterialDocumentLine: string;
    Material: string;
    MaterialDescription: string;
    ScrapeDescription?: string;
    QuantityInEntryUnit: string;
    CalculatedQty: string;
    EntryUnit: string;
    Plant: string;
    StorageLocation: string;
    Batch: string;
    GoodsMovementType: string;
    CostCenter: string;
}

/**
 * @namespace matdoc551.controller
 */
export default class calculateScrap extends Controller {

    private _oPageModel!: JSONModel;

    public onInit(): void {
        this._oPageModel = new JSONModel(this._getInitialPageData() as IPageModel);
        this.getView()?.setModel(this._oPageModel, "pageModel");

        (this.getOwnerComponent() as UIComponent)
            .getRouter()
            ?.getRoute("RouteCalculateScrap")
            ?.attachMatched(this._onRouteMatched, this);
    }

    private _onRouteMatched(): void {
        this._resetPage(false);

        const oShared = (this.getOwnerComponent() as UIComponent)
            .getModel("sharedData") as JSONModel | undefined;

        const aSourceRows = (oShared?.getProperty("/sourceRows") ?? []) as ISource551Row[];

        if (aSourceRows.length === 0) {
            this._showMessage("No 551 Material Document rows were received from the first page.", "Warning");
            this._showBottomMessage("No 551 Material Document rows were received from the first page.", "Warning");
            return;
        }

        this._setMIGOOverviewFrom551Rows(aSourceRows);
        this._oPageModel.setProperty("messageVisible", false);
        this._showBottomMessage("552 MIGO overview is ready. Enter Storage Location and Batch, then press Post 552.", "Information");
    }

    public onPost552(): void {
        const bPostEnabled = Boolean(this._oPageModel.getProperty("/post552Enabled"));
        if (!bPostEnabled) {
            this._showBottomMessage("Post 552 is not active. Go back to the first page and calculate scrap again.", "Warning");
            return;
        }

        const aItems = this._oPageModel.getProperty("/migoOverview/items") as IMIGOOverviewItem[];
        this._normalizeMIGOStorageAndBatch(aItems);

        if (!aItems || aItems.length === 0) {
            this._showBottomMessage("No line items are available for posting.", "Warning");
            return;
        }

        const aErrors: string[] = [];
        aItems.forEach((oItem, i) => {
            const sQty = String(oItem.CalculatedQty ?? oItem.QuantityInEntryUnit ?? "").trim();
            if (!sQty || isNaN(Number(sQty)) || Number(sQty) <= 0) {
                aErrors.push(`Line ${i + 1}: invalid Calculated Qty`);
            }
            if (!String(oItem.EntryUnit ?? "").trim()) {
                aErrors.push(`Line ${i + 1}: Entry Unit / Scrape Unit is required`);
            }
            if (!String(oItem.StorageLocation ?? "").trim()) {
                aErrors.push(`Line ${i + 1}: Storage Location is required`);
            }
            // Batch is not mandatory here. If the scrap material is not batch managed,
            // passing Batch to API_MATERIAL_DOCUMENT_SRV causes error MM_IM_ODATA_API_MDOC/012.
            if (!String(oItem.CostCenter ?? "").trim()) {
                aErrors.push(`Line ${i + 1}: Cost Center is required`);
            }
        });

        if (aErrors.length > 0) {
            this._showBottomMessage(aErrors.join(" | "), "Error");
            return;
        }

        MessageBox.confirm(
            `Post MIGO Movement Type 552 for ${aItems.length} item(s)?`,
            {
                title: "Confirm Post 552",
                onClose: (sAction: string | null) => {
                    if (sAction === MessageBox.Action.OK) {
                        this._postMIGO(aItems);
                    }
                }
            }
        );
    }

    private _postMIGO(aItems: IMIGOOverviewItem[]): void {
        const oModel = (this.getOwnerComponent() as UIComponent)
            .getModel("materialDocService") as ODataModel;

        if (!oModel) {
            this._showBottomMessage("Material Document service model not available. Check manifest.json.", "Error");
            return;
        }

        this._oPageModel.setProperty("/busy", true);
        this._oPageModel.setProperty("/post552Enabled", false);
        this._showBottomMessage("Posting 552 MIGO document...", "Information");

        const oSelectedPostingDate = this._getMIGOPostingDateObject();

        const oPayload = {
            DocumentDate: oSelectedPostingDate,
            PostingDate: oSelectedPostingDate,
            GoodsMovementCode: "06",
            to_MaterialDocumentItem: {
                results: aItems.map((oItem) => ({
                    MaterialDocumentLine: String(oItem.MaterialDocumentLine),
                    Material: String(oItem.Material).trim(),
                    QuantityInEntryUnit: String(oItem.CalculatedQty ?? oItem.QuantityInEntryUnit).trim(),
                    EntryUnit: String(oItem.EntryUnit).trim(),
                    Plant: String(oItem.Plant).trim(),
                    StorageLocation: this._normalizeUppercase(oItem.StorageLocation),
                    Batch: this._normalizeUppercase(oItem.Batch),
                    GoodsMovementType: "552",
                    CostCenter: String(oItem.CostCenter ?? "").trim()
                }))
            }
        };

        oModel.create("/A_MaterialDocumentHeader", oPayload, {
            success: (oData: { MaterialDocument?: string; FiscalYear?: string }) => {
                const sDocNum = oData?.MaterialDocument ?? "";
                const sYear = oData?.FiscalYear ?? "";

                this._oPageModel.setProperty("/migoOverview/MaterialDocument", sDocNum);
                this._oPageModel.setProperty("/migoOverview/FiscalYear", sYear);
                this._showBottomMessage(`552 MIGO posted successfully. Material Document ${sDocNum} / ${sYear}. Posting CBO data...`, "Success");
                MessageToast.show(`Material Document ${sDocNum} / ${sYear} posted successfully`);

                this._postInhouseRejectionCBO(sDocNum, sYear, aItems)
                    .then(() => {
                        this._afterSuccessfulMIGOAndCBOPosting(sDocNum, sYear);
                    })
                    .catch((oErr: object) => {
                        this._oPageModel.setProperty("/busy", false);
                        const sErrMsg = this._extractODataErrorMessage(
                            oErr,
                            "552 MIGO posted, but CBO posting failed. Please check the CBO service and data."
                        );
                        console.error("CBO posting failed", oErr);
                        this._setCBOStatus("CBO error", "Error");
                        this._showBottomMessage(`552 MIGO posted as ${sDocNum} / ${sYear}, but CBO posting failed: ${sErrMsg}`, "Error");
                    });
            },
            error: (oErr: object) => {
                this._oPageModel.setProperty("/busy", false);
                this._oPageModel.setProperty("/post552Enabled", true);
                const sErrMsg = this._extractODataErrorMessage(
                    oErr,
                    "Failed to post 552 MIGO document. Please check the data and try again."
                );
                console.error("Post 552 failed", oErr);
                this._showBottomMessage(sErrMsg, "Error");
            }
        });
    }


    private _afterSuccessfulMIGOAndCBOPosting(sDocNum: string, sYear: string): void {
        this._oPageModel.setProperty("/busy", false);
        this._setCBOStatus("CBO posted", "Success");
        this._clearShared551Bucket(true);
        this._clearSecondPageFields();
        this._showBottomMessage(`552 MIGO ${sDocNum} / ${sYear} and CBO data posted successfully. Go back to first page to start a new posting.`, "Success");
    }

    private _clearSecondPageFields(): void {
        const oData = this._getInitialPageData();
        oData.migoOverviewVisible = true;
        oData.cboStatusText = "CBO posted";
        oData.cboStatusState = "Success";
        oData.cboStatusIcon = "sap-icon://sys-enter-2";
        oData.post552Enabled = false;

        const sBottomMessage = this._oPageModel.getProperty("/bottomMessage") as string;
        const sBottomState = this._oPageModel.getProperty("/bottomState") as string;
        const sBottomIcon = this._oPageModel.getProperty("/bottomIcon") as string;
        const bBottomVisible = this._oPageModel.getProperty("/bottomVisible") as boolean;

        oData.bottomMessage = sBottomMessage;
        oData.bottomState = sBottomState;
        oData.bottomIcon = sBottomIcon;
        oData.bottomVisible = bBottomVisible;

        this._oPageModel.setData(oData);
    }

    private _clearShared551Bucket(bClearFirstPageOnReturn: boolean): void {
        (this.getOwnerComponent() as UIComponent).setModel(
            new JSONModel({
                sourceRows: [],
                plant: "",
                clearFirstPageOnReturn: bClearFirstPageOnReturn
            }),
            "sharedData"
        );
    }

    private async _postInhouseRejectionCBO(sMaterialDocument552: string, sFiscalYear552: string, aItems552: IMIGOOverviewItem[]): Promise<void> {
        const oCBOModel = (this.getOwnerComponent() as UIComponent)
            .getModel("inhouseRejectionService") as ODataModel;

        if (!oCBOModel) {
            throw new Error("Inhouse Rejection CBO service model not available. Check manifest.json.");
        }
        if (!sMaterialDocument552) {
            throw new Error("552 Material Document number was not returned by API_MATERIAL_DOCUMENT_SRV.");
        }

        this._setCBOStatus("Posting CBO...", "Information");

        const oShared = (this.getOwnerComponent() as UIComponent)
            .getModel("sharedData") as JSONModel | undefined;
        const aSourceRows = (oShared?.getProperty("/sourceRows") ?? []) as ISource551Row[];
        const sHeaderPlant = this._firstNonBlank(
            oShared?.getProperty("/plant"),
            aSourceRows[0]?.Plant,
            aItems552[0]?.Plant
        );

        const sCurrentYear = this._getCurrentYear();

        const oParent = await this._createOData(oCBOModel, "/YY1_INHOUSEREJECTION", {
            SAP_Description: `Inhouse Rejection 552 ${sMaterialDocument552}`,
            DocumentNumber: sMaterialDocument552,
            DocumentYear: sCurrentYear,
            Plant: sHeaderPlant
        }) as { SAP_UUID?: string };

        const sParentUuid = String(oParent?.SAP_UUID ?? "").trim();
        if (!sParentUuid) {
            throw new Error("CBO parent record was created, but SAP_UUID was not returned.");
        }

        // Child entities of this CBO are non-root entities. They cannot be created directly with
        // /YY1_MATERIALDOCUMENTS551_INHOU or /YY1_SCRAPEDATA552_INHOUSEREJEC.
        // Create them through the parent navigation properties so SAP sets SAP_PARENT_UUID itself.
        const sParentPath = `/YY1_INHOUSEREJECTION(guid'${sParentUuid}')`;

        for (const oRow of aSourceRows) {
            await this._createOData(oCBOModel, `${sParentPath}/to_MaterialDocuments551`, this._build551CBOPayload(oRow));
        }

        for (const oItem of aItems552) {
            await this._createOData(oCBOModel, `${sParentPath}/to_ScrapeData552`, this._build552CBOPayload(oItem, sMaterialDocument552, sFiscalYear552));
        }
    }

    private _build551CBOPayload(oRow: ISource551Row): Record<string, unknown> {
        // Quantity_V must never be blank. In some SmartTable variants QuantityInEntryUnit is not selected,
        // so we fall back to QuantityInBaseUnit. If both are missing, use NetWeightTotal only to prevent
        // the CBO numeric field from receiving an empty string.
        const sQuantity = this._normalizeDecimalForCBO(
            this._firstNonBlank(oRow.QuantityInEntryUnit, oRow.QuantityInBaseUnit, oRow.NetWeightTotal)
        );
        const sQuantityUnit = this._firstNonBlank(oRow.EntryUnit, oRow.MaterialBaseUnit, oRow.ScrapeUnit);
        const sNetWeight = this._normalizeDecimalForCBO(oRow.NetWeightTotal);
        // NetWeightTotal_U must come from the original 551 row WeightUnit (KG), not ScrapeUnit (EA).
        const sNetWeightUnit = this._firstNonBlank(oRow.WeightUnit, oRow.MaterialBaseUnit, "KG");
        const vPostingDate = this._toDateObject(oRow.PostingDate) ?? this._getTodayDateObject();

        return {
            MaterialDocument: this._firstNonBlank(oRow.MaterialDocument),
            MaterialDocumentItem: this._padMaterialDocumentItem(this._firstNonBlank(oRow.MaterialDocumentItem)),
            MaterialDocumentYear: this._firstNonBlank(oRow.MaterialDocumentYear),
            Material: this._firstNonBlank(oRow.Material),
            MaterialDescription: this._firstNonBlank(oRow.MaterialDescription, oRow.ProductDescription),
            Quantity_V: sQuantity,
            Quantity_U: sQuantityUnit,
            NetWeightTotal_V: sNetWeight,
            NetWeightTotal_U: sNetWeightUnit,
            Plant: this._firstNonBlank(oRow.Plant),
            StorageLocation: this._firstNonBlank(oRow.StorageLocation),
            PostingDate: vPostingDate,
            Batch: this._firstNonBlank(oRow.Batch),
            CostCenter: this._firstNonBlank(oRow.CostCenter)
        };
    }

    private _build552CBOPayload(oItem: IMIGOOverviewItem, sMaterialDocument552: string, _sFiscalYear552: string): Record<string, unknown> {
        // 552 CBO must store the same quantity/unit that was posted in the 552 MIGO line.
        // These come from the page-2 overview: ScrapeNetWeight_V = QuantityInEntryUnit,
        // ScrapeNetWeight_U = EntryUnit.
        return {
            MaterialDocument: sMaterialDocument552,
            MaterialDocumentItem: this._padMaterialDocumentItem(oItem.MaterialDocumentLine),
            MaterialDocumentYear: this._getCurrentYear(),
            Material: this._firstNonBlank(oItem.Material),
            MaterialDescription: this._firstNonBlank(oItem.ScrapeDescription, oItem.MaterialDescription),
            ScrapeNetWeight_V: this._normalizeDecimalForCBO(oItem.CalculatedQty ?? oItem.QuantityInEntryUnit),
            ScrapeNetWeight_U: this._firstNonBlank(oItem.EntryUnit),
            Plant: this._firstNonBlank(oItem.Plant),
            StorageLocation: this._normalizeUppercase(oItem.StorageLocation),
            CostCenter: this._firstNonBlank(oItem.CostCenter),
            Batch: this._normalizeUppercase(oItem.Batch),
            PostingDate: this._getMIGOPostingDateObject(),
            MovementType: "552"
        };
    }

    private _firstNonBlank(...aValues: unknown[]): string {
        for (const vValue of aValues) {
            const sValue = String(vValue ?? "").trim();
            if (sValue) {
                return sValue;
            }
        }
        return "";
    }

    public onUppercaseMIGOField(oEvent: Event): void {
        const oInput = oEvent.getSource() as Input;
        const sUppercaseValue = this._normalizeUppercase(oInput.getValue());
        oInput.setValue(sUppercaseValue);

        const oContext = oInput.getBindingContext("pageModel");
        const sPath = oContext?.getPath();
        if (!sPath) {
            return;
        }

        const sInputId = oInput.getId();
        const sProperty = sInputId.includes("migoCellSLoc")
            ? "StorageLocation"
            : sInputId.includes("migoCellBatch")
                ? "Batch"
                : "";

        if (sProperty) {
            this._oPageModel.setProperty(`${sPath}/${sProperty}`, sUppercaseValue);
        }
    }

    private _normalizeMIGOStorageAndBatch(aItems: IMIGOOverviewItem[] | undefined): void {
        if (!Array.isArray(aItems)) {
            return;
        }

        aItems.forEach((oItem) => {
            oItem.StorageLocation = this._normalizeUppercase(oItem.StorageLocation);
            oItem.Batch = this._normalizeUppercase(oItem.Batch);
        });
        this._oPageModel.setProperty("/migoOverview/items", aItems);
    }

    private _normalizeUppercase(vValue: unknown): string {
        return String(vValue ?? "").trim().toUpperCase();
    }

    private _normalizeDecimalForCBO(vValue: unknown): string {
        const sValue = String(vValue ?? "").replace(/,/g, "").trim();
        if (!sValue) {
            return "0";
        }

        const nValue = Number(sValue);
        if (!Number.isFinite(nValue)) {
            return "0";
        }

        return Number.isInteger(nValue) ? String(nValue) : String(Number(nValue.toFixed(3)));
    }

    private _createOData(oModel: ODataModel, sPath: string, oPayload: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            oModel.create(sPath, oPayload, {
                success: (oData: unknown) => resolve(oData),
                error: (oErr: object) => reject(oErr)
            });
        });
    }

    private _setCBOStatus(sText: string, sState: string): void {
        const sIcon = sState === "Error" ? "sap-icon://error" :
            sState === "Warning" ? "sap-icon://alert" :
                sState === "Success" ? "sap-icon://sys-enter-2" :
                    sState === "Information" ? "sap-icon://synchronize" :
                        "sap-icon://pending";

        this._oPageModel.setProperty("/cboStatusText", sText);
        this._oPageModel.setProperty("/cboStatusState", sState);
        this._oPageModel.setProperty("/cboStatusIcon", sIcon);
    }

    private _getCurrentYear(): string {
        return String(new Date().getFullYear());
    }

    private _getTodayDateObject(): Date {
        const oToday = new Date();
        // Build UTC midnight of *today's local calendar day*. ODataModel v2 serializes
        // Date objects using getTime() (UTC epoch ms) for the /Date(ticks)/ wire value.
        // Using local-midnight (setHours(0,0,0,0)) rolls back to the previous day in UTC
        // for any timezone ahead of UTC (e.g. IST, UTC+5:30), which the backend then
        // commits as the posting date. UTC midnight avoids that rollback.
        return new Date(Date.UTC(oToday.getFullYear(), oToday.getMonth(), oToday.getDate()));
    }

    private _getMIGOPostingDateObject(): Date {
        const vPostingDate = this._oPageModel.getProperty("/migoOverview/PostingDate") as string | Date | undefined;
        return this._toDateObject(vPostingDate) ?? this._getTodayDateObject();
    }

    private _toDateObject(vDate: string | Date | undefined): Date | null {
        if (!vDate) {
            return null;
        }

        let oDate: Date;
        if (vDate instanceof Date) {
            oDate = vDate;
        } else {
            const sDate = String(vDate).trim();
            const oMatch = /\/Date\((\d+)/.exec(sDate);
            oDate = oMatch ? new Date(Number(oMatch[1])) : new Date(sDate);
        }

        if (Number.isNaN(oDate.getTime())) {
            return null;
        }

        // Take the *local* calendar day the user intended (from the DatePicker or parsed
        // string) and re-anchor it at UTC midnight, so serialization to OData never rolls
        // it back to the previous day. See _getTodayDateObject() for why.
        return new Date(Date.UTC(oDate.getFullYear(), oDate.getMonth(), oDate.getDate()));
    }

    private _padMaterialDocumentItem(vItem: unknown): string {
        const sItem = String(vItem ?? "").trim();
        if (!sItem) {
            return "";
        }
        return /^\d+$/.test(sItem) ? sItem.padStart(4, "0") : sItem;
    }


    public onNavBack(): void {
        const oShared = (this.getOwnerComponent() as UIComponent).getModel("sharedData") as JSONModel | undefined;
        const bClearFirstPageOnReturn = Boolean(oShared?.getProperty("/clearFirstPageOnReturn"));
        this._clearShared551Bucket(bClearFirstPageOnReturn);
        const sPrevHash = History.getInstance().getPreviousHash();
        if (sPrevHash !== undefined) {
            window.history.go(-1);
            return;
        }
        (this.getOwnerComponent() as UIComponent)
            .getRouter()?.navTo("Routeinhouserejectiontest", {}, true);
    }

    private _setMIGOOverviewFrom551Rows(aSourceRows: ISource551Row[]): void {
        const oToday = new Date();
        const sToday = this._formatDate(oToday);
        const mGroups = new Map<string, {
            ScrapItem: string;
            MaterialDescription: string;
            ScrapeDescription: string;
            Plant: string;
            CostCenter: string;
            EntryUnit: string;
            Quantity: number;
        }>();

        aSourceRows.forEach((oRow) => {
            const sScrapItem = String(oRow.ScrapItem ?? "").trim();
            const sMaterialDescription = String(oRow.MaterialDescription ?? oRow.ProductDescription ?? "").trim();
            const sScrapeDescription = String(oRow.ScrapeDescription ?? "").trim();
            const sPlant = String(oRow.Plant ?? "").trim();
            const sCostCenter = String(oRow.CostCenter ?? "").trim();
            const sEntryUnit = String(oRow.ScrapeUnit ?? "").trim();
            const nQty = this._toNumber(oRow.NetWeightTotal);

            if (!sScrapItem || !sPlant || !sEntryUnit || nQty <= 0) {
                return;
            }

            const sKey = [sScrapItem, sPlant, sCostCenter].join("|");
            const oGroup = mGroups.get(sKey);

            if (oGroup) {
                oGroup.Quantity += nQty;
                if (!oGroup.EntryUnit && sEntryUnit) {
                    oGroup.EntryUnit = sEntryUnit;
                }
                if (!oGroup.MaterialDescription && sMaterialDescription) {
                    oGroup.MaterialDescription = sMaterialDescription;
                }
                if (!oGroup.ScrapeDescription && sScrapeDescription) {
                    oGroup.ScrapeDescription = sScrapeDescription;
                }
                return;
            }

            mGroups.set(sKey, {
                ScrapItem: sScrapItem,
                MaterialDescription: sMaterialDescription,
                ScrapeDescription: sScrapeDescription,
                Plant: sPlant,
                CostCenter: sCostCenter,
                EntryUnit: sEntryUnit,
                Quantity: nQty
            });
        });

        const aItems: IMIGOOverviewItem[] = Array.from(mGroups.values()).map((oGroup, i) => ({
            MaterialDocumentLine: String(i + 1),
            Material: oGroup.ScrapItem,
            MaterialDescription: oGroup.MaterialDescription,
            ScrapeDescription: oGroup.ScrapeDescription,
            QuantityInEntryUnit: this._formatQuantity(oGroup.Quantity),
            CalculatedQty: this._formatQuantity(oGroup.Quantity),
            EntryUnit: oGroup.EntryUnit,
            Plant: oGroup.Plant,
            StorageLocation: "SR14",
            Batch: "",
            GoodsMovementType: "552",
            CostCenter: oGroup.CostCenter
        }));

        if (aItems.length === 0) {
            this._showMessage("No valid 551 rows with Scrap Item, Net Weight Total and Scrape Unit were found.", "Warning");
            return;
        }

        this._oPageModel.setProperty("/migoOverview", {
            MaterialDocument: "Not posted yet",
            FiscalYear: "",
            DocumentDate: sToday,
            PostingDate: sToday,
            GoodsMovementCode: "06",
            items: aItems
        } as IMIGOOverview);
        this._oPageModel.setProperty("/migoOverviewVisible", true);
        this._oPageModel.setProperty("/post552Enabled", true);
    }

    private _toNumber(vValue: unknown): number {
        if (vValue === null || vValue === undefined) {
            return 0;
        }

        const sValue = String(vValue).replace(/,/g, "").trim();
        const nValue = Number(sValue);
        return Number.isFinite(nValue) ? nValue : 0;
    }

    private _formatQuantity(nValue: number): string {
        return Number.isInteger(nValue) ? String(nValue) : String(Number(nValue.toFixed(3)));
    }


    private _getInitialPageData(): IPageModel {
        return {
            busy: false,
            message: "",
            messageType: "Information",
            messageVisible: false,
            migoOverviewVisible: false,
            migoOverview: {
                MaterialDocument: "",
                FiscalYear: "",
                DocumentDate: "",
                PostingDate: "",
                GoodsMovementCode: "06",
                items: []
            },
            cboStatusText: "Not posted on CBO",
            cboStatusState: "None",
            cboStatusIcon: "sap-icon://pending",
            bottomMessage: "",
            bottomState: "Information",
            bottomIcon: "sap-icon://message-information",
            bottomVisible: false,
            post552Enabled: false
        };
    }

    private _resetPage(bBusy: boolean): void {
        const oData = this._getInitialPageData();
        oData.busy = bBusy;
        this._oPageModel.setData(oData);
    }

    private _showMessage(sText: string, sType: string): void {
        this._oPageModel.setProperty("/busy", false);
        this._oPageModel.setProperty("/message", sText);
        this._oPageModel.setProperty("/messageType", sType);
        this._oPageModel.setProperty("/messageVisible", true);
        this._oPageModel.setProperty("/migoOverviewVisible", false);
    }

    private _showBottomMessage(sText: string, sState: string): void {
        const sIcon = sState === "Error" ? "sap-icon://error" :
            sState === "Warning" ? "sap-icon://alert" :
                sState === "Success" ? "sap-icon://sys-enter-2" :
                    "sap-icon://message-information";

        this._oPageModel.setProperty("/bottomMessage", sText);
        this._oPageModel.setProperty("/bottomState", sState);
        this._oPageModel.setProperty("/bottomIcon", sIcon);
        this._oPageModel.setProperty("/bottomVisible", Boolean(sText));
    }

    private _formatDate(oDate: Date): string {
        const sYear = String(oDate.getFullYear());
        const sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
        const sDay = String(oDate.getDate()).padStart(2, "0");
        return `${sYear}-${sMonth}-${sDay}`;
    }

    private _extractODataErrorMessage(oErr: object, sFallback: string): string {
        const oAnyErr = oErr as { responseText?: string; message?: string; response?: { body?: string } };
        const sResponseText = oAnyErr.responseText ?? oAnyErr.response?.body ?? "";

        if (sResponseText) {
            try {
                const oBody = JSON.parse(sResponseText) as {
                    error?: {
                        message?: { value?: string } | string;
                        innererror?: { errordetails?: Array<{ message?: string }> };
                    }
                };

                const vMainMessage = oBody?.error?.message;
                const sMainMessage = typeof vMainMessage === "string"
                    ? vMainMessage
                    : vMainMessage?.value;
                const sDetailMessage = oBody?.error?.innererror?.errordetails
                    ?.map((d) => d.message)
                    .filter(Boolean)
                    .join(" | ");

                return sMainMessage || sDetailMessage || sFallback;
            } catch {
                return sResponseText || sFallback;
            }
        }

        return oAnyErr.message || sFallback;
    }
}