/*global QUnit*/
import Controller from "matdoc551/controller/matdoc551.controller";

QUnit.module("matdoc551 Controller");

QUnit.test("I should test the matdoc551 controller", function (assert: Assert) {
	const oAppController = new Controller("matdoc551");
	oAppController.onInit();
	assert.ok(oAppController);
});